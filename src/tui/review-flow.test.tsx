import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { contextReportFixture } from '../../test/support/context-report.js'
import { watchedRepository } from '../../test/support/home.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import {
  emptyRepositories,
  frameLines,
  KEYS,
  NOW,
  renderApp,
  visibleWidth,
} from '../../test/support/tui.js'
import type { ReviewDetail } from '../app/read-history.js'
import type {
  OpenPullRequests,
  PullRequestTarget,
  RequestedReview,
  ReviewMode,
} from '../app/requested-review.js'
import type { ReviewProgressSink } from '../app/review-progress.js'
import type { AppDeps } from './app-context.js'
import type { TerminalSize } from './terminal-size.js'

afterEach(() => cleanup())

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const TARGET: PullRequestTarget = { owner: 'acme', repo: 'shop', number: 12 }

const OPEN: OpenPullRequests = {
  status: 'read',
  repo: 'acme/shop',
  pulls: [
    { number: 12, title: 'Let users spend crystals', author: 'octocat', draft: false },
    { number: 9, title: 'Try a new \u001B[2Jcart', author: 'bo', draft: true },
  ],
}

function detail(changes: Partial<ReviewDetail> = {}): ReviewDetail {
  return {
    run: {
      source: 'manual',
      repo: 'acme/shop',
      number: 12,
      headSha: SHA,
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      status: 'dry-run',
      aiCalled: true,
      provider: 'claude',
      verdict: 'comments',
      score: 3,
      findings: 1,
    },
    pullRequest: { url: 'https://github.com/acme/shop/pull/12', title: 'Let users spend crystals' },
    verdict: 'comments',
    score: { value: 3, reason: 'One P1.' },
    summary: 'Adds a spend endpoint.',
    findings: [
      {
        severity: 'P1',
        confidence: 90,
        file: 'src/shop.ts',
        line: 8,
        title: 'spend has no auth',
        why: 'Anyone can spend crystals for any user.',
        fix: null,
        rule: null,
        skill: null,
        sources: [],
      },
    ],
    worthChecking: [],
    publication: {
      status: 'dry-run',
      url: null,
      comments: 1,
      wouldResolve: 2,
      reason: null,
    },
    ci: null,
    published: [],
    ...changes,
  }
}

interface Asked {
  target: PullRequestTarget
  mode: ReviewMode
  progress: ReviewProgressSink
  resolve(review: RequestedReview): void
  reject(error: unknown): void
}

function openFlow(
  options: {
    size?: TerminalSize
    language?: string
    deps?: Partial<AppDeps>
  } = {},
) {
  const asked: Asked[] = []
  let time = NOW.getTime()
  const app = renderApp({
    size: options.size ?? { columns: 80, rows: 24 },
    deps: {
      ...(options.language === undefined ? {} : { language: options.language }),
      now: () => new Date(time),
      readRepositories: async () => ({
        ...emptyRepositories(),
        configured: true,
        repositories: [watchedRepository('acme/shop', true), watchedRepository('acme/web', false)],
      }),
      readOpenPullRequests: async () => OPEN,
      readGitHub: async () => ({ source: 'gh', account: { state: 'found', login: 'ana' } }),
      reviewPullRequest: (target, mode, progress) =>
        new Promise((resolve, reject) => {
          asked.push({ target, mode, progress, resolve, reject })
        }),
      ...options.deps,
    },
  })
  const fromPalette = async () => {
    await app.showing('Home')
    await app.press('/')
    await app.type('review a')
    await app.press(KEYS.enter)
    await app.showing('Pull request:')
  }
  const later = (ms: number) => {
    time += ms
    app.clock.advance(ms)
  }
  return { ...app, asked, fromPalette, later }
}

function expectFits(frame: string, { columns, rows }: TerminalSize) {
  const lines = frameLines(frame)
  expect(lines.length).toBeLessThanOrEqual(rows)
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(columns)
}

describe('reviewing a pull request from the app', () => {
  it('opens from the palette in place of the tabs with the field to type the pull request', async () => {
    const { frame, footer, fromPalette, showing } = openFlow()
    await fromPalette()
    await showing('acme/web')
    expect(frame()).toContain('Review a pull request')
    expect(frame()).not.toContain('Queue')
    expect(frame()).toContain('Type owner/repo#N or the pull request URL')
    expect(frame()).toContain('acme/shop')
    expect(footer()).toContain('Enter review')
    expectFits(frame(), { columns: 80, rows: 24 })
  })

  it('takes a typed pull request to the mode, and refuses what is not one', async () => {
    const { frame, footer, fromPalette, press, showing, type } = openFlow()
    await fromPalette()
    await type('acme/shop')
    await press(KEYS.enter)
    await showing('is not a pull request')
    expect(frame()).toContain('“acme/shop” is not a pull request: type owner/repo#N or its URL.')
    expect(footer()).toContain('t type a pull request')
    await press('t')
    await type('#12')
    await press(KEYS.enter)
    await showing('How should Phada review it?')
    expect(frame()).toContain('acme/shop#12')
    expect(frame()).toMatch(/❯ Only look\s+review here, post nothing/)
    expect(frame()).toContain('Review and publish')
    expectFits(frame(), { columns: 80, rows: 24 })
  })

  it('lists the open pull requests of a picked repository and goes back with Esc', async () => {
    const { frame, footer, fromPalette, press, showing } = openFlow()
    await fromPalette()
    await press(KEYS.escape)
    await showing('t type a pull request')
    expect(footer()).toContain('Enter open')
    await press(KEYS.enter)
    await showing('Open pull requests of acme/shop')
    await showing('#12')
    expect(frame()).toMatch(/❯ #12\s+Let users spend crystals\s+@octocat/)
    expect(frame()).toMatch(/#9\s+Try a new \[2Jcart\s+@bo\s+draft/)
    expect(frame()).not.toContain('\u001B[2J')
    expect(footer()).toContain('r refresh')
    expectFits(frame(), { columns: 80, rows: 24 })
    await press(KEYS.enter)
    await showing('How should Phada review it?')
    expect(frame()).toContain('acme/shop#12 · Let users spend crystals')
    await press(KEYS.escape)
    await showing('Open pull requests of acme/shop')
    expect(frame()).toContain('#9')
    await press(KEYS.escape)
    await showing('t type a pull request')
    expect(footer()).toContain('t type a pull request')
    expect(frame()).toContain('❯ acme/shop')
  })

  it('says why the open pull requests could not be read', async () => {
    const failing = openFlow({
      deps: { readOpenPullRequests: () => Promise.reject(new Error('Bad credentials')) },
    })
    await failing.fromPalette()
    await failing.press(KEYS.escape, KEYS.enter)
    await failing.showing('Bad credentials')
    expect(failing.frame()).toContain('Could not load: Bad credentials')
    cleanup()

    const tokenless = openFlow({
      deps: { readOpenPullRequests: async () => ({ status: 'no-token' }) },
    })
    await tokenless.fromPalette()
    await tokenless.press(KEYS.escape, KEYS.enter)
    await tokenless.showing('No GitHub token')
    expect(tokenless.frame()).toContain('No GitHub token — gh auth login or set GITHUB_TOKEN')
  })

  it('only looks: shows each step live with the AI time, then the result, and Esc goes back to the screen', async () => {
    const { asked, frame, footer, fromPalette, later, press, showing, type, until } = openFlow()
    await fromPalette()
    await type('acme/shop#12')
    await press(KEYS.enter)
    await showing('How should Phada review it?')
    await press(KEYS.enter)
    await until(() => asked.length === 1)
    expect(asked[0]).toMatchObject({ target: TARGET, mode: 'look' })
    await showing('Fetching acme/shop#12…')
    expect(frame()).toContain('Only looking: nothing will be posted.')
    expect(footer()).not.toContain('Esc')

    const progress = asked[0]?.progress ?? (() => undefined)
    progress({ kind: 'fetched', pullRequest: pullRequestFixture() })
    progress({ kind: 'contextLoaded', report: contextReportFixture() })
    progress({ kind: 'indexing', total: 40 })
    progress({ kind: 'indexed', done: 10, total: 40 })
    progress({ kind: 'aiStarted', provider: 'claude-cli', run: 'review' })
    progress({ kind: 'warning', message: 'The CI logs are gone.' })
    await showing('claude-cli: review · 0s')
    expect(frame()).toContain('✓ Pull request: Let users spend crystals')
    expect(frame()).toContain('✓ Context: 1 rules, 1 docs')
    expect(frame()).toContain('Indexing: 10 of 40 files')
    expect(frame()).toContain('› claude-cli: review · 0s')
    expect(frame()).toContain('The CI logs are gone.')
    later(12_000)
    await showing('claude-cli: review · 12s')
    expect(frame()).toContain('› claude-cli: review · 12s')
    expectFits(frame(), { columns: 80, rows: 24 })

    progress({ kind: 'aiFinished', provider: 'claude-cli', run: 'review' })
    asked[0]?.resolve({
      status: 'reviewed',
      detail: detail(),
      history: { status: 'saved', runId: 3 },
    })
    await showing('Done in 12s.')
    expect(frame()).toContain('Saved in the history.')
    expect(frame()).toContain('acme/shop#12 · Let users spend crystals')
    expect(frame()).toMatch(/Score\s+3\/5 — One P1\./)
    expect(frame()).toMatch(/Published\s+nothing was posted · 1 comment · would resolve 2/)
    expect(frame()).toMatch(/P1\s+src\/shop.ts:8\s+spend has no auth/)
    expect(footer()).toContain('Esc back')
    expectFits(frame(), { columns: 80, rows: 24 })
    await press(KEYS.escape)
    await showing('Review pull requests with the AI you already use.')
    expect(frame()).toContain('Home')
  })

  it('asks before publishing, with the pull request and who publishes it, and Esc goes back to the mode', async () => {
    const { asked, frame, footer, fromPalette, press, showing, until } = openFlow()
    await fromPalette()
    await press(KEYS.escape, KEYS.enter)
    await showing('#12')
    await press(KEYS.enter)
    await showing('How should Phada review it?')
    await press(KEYS.down, KEYS.enter)
    await showing('Publish the review on GitHub?')
    await showing('@ana')
    expect(frame()).toMatch(/Pull request\s+acme\/shop#12 · Let users spend crystals/)
    expect(frame()).toMatch(/Published as\s+@ana/)
    expect(footer()).toContain('Enter publish')
    await press(KEYS.escape)
    await showing('How should Phada review it?')
    expect(frame()).toMatch(/❯ Review and publish/)
    expect(asked).toEqual([])
    await press(KEYS.enter)
    await showing('Publish the review on GitHub?')
    await press(KEYS.enter)
    await until(() => asked.length === 1)
    expect(asked[0]).toMatchObject({ target: TARGET, mode: 'publish' })
    await showing('Reviewing and publishing on the pull request.')
    asked[0]?.progress({ kind: 'publishing' })
    await showing('Publishing on GitHub…')
    asked[0]?.resolve({
      status: 'reviewed',
      detail: detail({
        publication: {
          status: 'published',
          url: 'https://github.com/acme/shop/pull/12#pullrequestreview-9',
          comments: 1,
          wouldResolve: null,
          reason: null,
        },
      }),
      history: { status: 'off' },
    })
    await showing('pullrequestreview-9')
    expect(frame()).toContain('Not saved: the history is off in the user config.')
  })

  it('does not publish without a GitHub token', async () => {
    const { footer, frame, fromPalette, press, showing, type } = openFlow({
      deps: { readGitHub: async () => ({ source: null }) },
    })
    await fromPalette()
    await type('acme/shop#12')
    await press(KEYS.enter)
    await showing('How should Phada review it?')
    await press(KEYS.down, KEYS.enter)
    await showing('No GitHub token')
    expect(frame()).toMatch(/Published as\s+No GitHub token/)
    expect(footer()).not.toContain('Enter publish')
  })

  it('shows the error of a failed review with the steps it got to', async () => {
    const { asked, frame, fromPalette, press, showing, type, until } = openFlow()
    await fromPalette()
    await type('acme/shop#12')
    await press(KEYS.enter)
    await showing('How should Phada review it?')
    await press(KEYS.enter)
    await until(() => asked.length === 1)
    asked[0]?.progress({ kind: 'fetched', pullRequest: pullRequestFixture() })
    asked[0]?.reject(new Error('The AI CLI is not \u001B[31mlogged in'))
    await showing('The review failed.')
    expect(frame()).toContain('The AI CLI is not [31mlogged in')
    expect(frame()).not.toContain('\u001B[31m')
    expect(frame()).toContain('✓ Pull request: Let users spend crystals')
  })

  it('opens with n on the Reviews screen and goes back there', async () => {
    const { frame, footer, press, showing } = openFlow()
    await showing('Home')
    await press('4')
    await showing('No reviews yet.')
    expect(footer()).toContain('n review a pull request')
    await press('n')
    await showing('Pull request:')
    expect(frame()).toContain('Review a pull request')
    await press(KEYS.escape, KEYS.escape)
    await showing('No reviews yet.')
    expect(frame()).toContain('No reviews yet.')
  })

  it('opens with v on a repository straight on its open pull requests', async () => {
    const { frame, footer, press, showing } = openFlow()
    await showing('Home')
    await press('2')
    await showing('acme/web')
    await press('v')
    await showing('Open pull requests of acme/shop')
    await showing('#12')
    expect(frame()).toContain('Let users spend crystals')
    expect(footer()).toContain('Esc back')
    await press(KEYS.escape)
    await showing('2 repositories · 2 watched')
    expect(frame()).toContain('acme/web')
  })

  it.each([
    ['pt', 'Revisar um pull request', 'Como a Phada deve revisar?', 'Só ver'],
    ['es', 'Revisar un pull request', '¿Cómo debe revisarlo Phada?', 'Solo ver'],
  ])('is translated (%s)', async (language, title, question, look) => {
    const { frame, press, showing, type } = openFlow({ language })
    await showing('Phada')
    await press('/')
    await type(title.slice(0, 9).toLowerCase())
    await press(KEYS.enter)
    await showing('Pull request:')
    expect(frame()).toContain(title)
    await type('acme/shop#12')
    await press(KEYS.enter)
    await showing(question)
    expect(frame()).toContain(look)
    expectFits(frame(), { columns: 80, rows: 24 })
  })
})
