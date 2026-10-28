import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { contextReportFixture } from '../../test/support/context-report.js'
import { watchedRepository } from '../../test/support/home.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import {
  emptyQueue,
  emptyRepositories,
  flatFrame,
  frameLines,
  KEYS,
  NOW,
  renderApp,
  visibleWidth,
} from '../../test/support/tui.js'
import type { ReviewDetail } from '../app/read-history.js'
import type { EnqueuedReview } from '../app/requested-review.js'
import type { JobRecord } from '../watch/types.js'
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
  signal: AbortSignal
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
      reviewPullRequest: (target, mode, progress, signal) =>
        new Promise((resolve, reject) => {
          asked.push({ target, mode, progress, signal, resolve, reject })
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
    expect(footer()).toContain('Esc cancel')

    const progress = asked[0]?.progress ?? (() => undefined)
    progress({ kind: 'fetched', pullRequest: pullRequestFixture() })
    progress({ kind: 'contextLoaded', report: contextReportFixture() })
    progress({
      kind: 'conversationRead',
      conversation: {
        items: [],
        report: { items: 1, omitted: 0, resolved: 0, bots: 0, truncated: 0, bytes: 120 },
      },
    })
    progress({
      kind: 'impactReady',
      report: {
        status: 'used',
        changed: [
          {
            kind: 'function',
            name: 'spend',
            path: 'src/wallet.ts',
            lines: [3, 9],
            callers: 2,
            files: 1,
            shown: 2,
            dependencies: 0,
            capped: false,
          },
        ],
        totals: { symbols: 1, callers: 2, files: 1 },
        learned: [],
      },
    })
    progress({ kind: 'indexing', total: 40 })
    progress({ kind: 'indexed', done: 10, total: 40 })
    progress({ kind: 'aiStarted', provider: 'claude-cli', run: 'review' })
    progress({ kind: 'warning', message: 'The CI logs are gone.' })
    await showing('claude-cli: review · 0s')
    expect(frame()).toContain('✓ Pull request: Let users spend crystals')
    expect(frame()).toContain('✓ Context: 1 rule, 1 doc')
    expect(frame()).toContain('✓ Conversation: 1 item')
    expect(frame()).toContain('✓ Impact: 1 changed symbol')
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

  async function running(flow: ReturnType<typeof openFlow>, publish = false) {
    await flow.fromPalette()
    await flow.type('acme/shop#12')
    await flow.press(KEYS.enter)
    await flow.showing('How should Phada review it?')
    if (publish) {
      await flow.press(KEYS.down, KEYS.enter)
      await flow.showing('@ana')
    }
    await flow.press(KEYS.enter)
    await flow.until(() => flow.asked.length === 1)
    const asked = flow.asked[0]
    if (asked === undefined) throw new Error('no review asked')
    return asked
  }

  it('asks before cancelling with Esc, keeps running on Esc and cancels on Enter', async () => {
    const flow = openFlow()
    const { frame, footer, press, showing } = flow
    const asked = await running(flow)
    asked.progress({ kind: 'fetched', pullRequest: pullRequestFixture() })
    await showing('✓ Pull request: Let users spend crystals')
    expect(footer()).toContain('Esc cancel')
    await press(KEYS.escape)
    await showing('Cancel the review? Nothing will be posted.')
    expect(footer()).toContain('Enter cancel the review')
    expect(footer()).toContain('Esc keep running')
    expectFits(frame(), { columns: 80, rows: 24 })
    await press(KEYS.escape)
    await showing('Esc cancel')
    expect(frame()).not.toContain('Cancel the review?')
    expect(asked.signal.aborted).toBe(false)
    await press(KEYS.escape)
    await showing('Cancel the review?')
    await press(KEYS.enter)
    await showing('Cancelling…')
    expect(asked.signal.aborted).toBe(true)
    expect(footer()).not.toContain('Esc')
    asked.resolve({ status: 'cancelled' })
    await showing('Cancelled: nothing was posted.')
    expect(frame()).toContain('✓ Pull request: Let users spend crystals')
    expect(footer()).toContain('Esc back')
    expectFits(frame(), { columns: 80, rows: 24 })
    await press(KEYS.escape)
    await showing('Review pull requests with the AI you already use.')
    expect(frame()).toContain('Home')
  })

  it('cannot be cancelled once it is publishing', async () => {
    const flow = openFlow()
    const asked = await running(flow, true)
    asked.progress({ kind: 'publishing' })
    await flow.showing('Publishing on GitHub…')
    expect(flow.footer()).not.toContain('Esc')
    await flow.press(KEYS.escape)
    await flow.showing('Publishing on GitHub…')
    expect(flow.frame()).not.toContain('Cancel the review?')
    expect(asked.signal.aborted).toBe(false)
  })

  it('asks before quitting while it runs: Esc stays, Enter cancels it and quits', async () => {
    const flow = openFlow()
    const asked = await running(flow)
    await flow.press('q')
    await flow.showing('A review is running: cancel it and quit?')
    expect(flow.exits).toEqual([])
    expectFits(flow.frame(), { columns: 80, rows: 24 })
    await flow.press(KEYS.escape)
    await flow.showing('Only looking: nothing will be posted.')
    expect(asked.signal.aborted).toBe(false)
    await flow.press(KEYS.ctrlC)
    await flow.showing('cancel it and quit?')
    await flow.press(KEYS.enter)
    await flow.until(() => flow.exits.length > 0)
    expect(flow.exits).toEqual([{ kind: 'interrupted' }])
    expect(asked.signal.aborted).toBe(true)
  })

  it('cancels it and quits at once on a second Ctrl-C', async () => {
    const flow = openFlow()
    const asked = await running(flow)
    await flow.press(KEYS.ctrlC)
    await flow.showing('cancel it and quit?')
    await flow.press(KEYS.ctrlC)
    await flow.until(() => flow.exits.length > 0)
    expect(flow.exits).toEqual([{ kind: 'interrupted' }])
    expect(asked.signal.aborted).toBe(true)
  })

  it('waits for a publication under way before quitting', async () => {
    const flow = openFlow()
    const asked = await running(flow, true)
    asked.progress({ kind: 'publishing' })
    await flow.showing('Publishing on GitHub…')
    await flow.press('q')
    await flow.showing('cancel it and quit?')
    await flow.press(KEYS.enter)
    await flow.showing('Stopping…')
    expect(flow.exits).toEqual([])
    asked.resolve({ status: 'reviewed', detail: detail(), history: { status: 'off' } })
    await flow.until(() => flow.exits.length > 0)
    expect(flow.exits).toEqual([{ kind: 'quit' }])
  })

  function job(changes: Partial<JobRecord> = {}): JobRecord {
    return {
      id: 7,
      repo: 'acme/shop',
      number: 12,
      headSha: SHA,
      status: 'queued',
      attempts: 0,
      notBefore: NOW.toISOString(),
      publish: 'pr',
      createdAt: NOW.toISOString(),
      ...changes,
    }
  }

  function watching(enqueued: () => Promise<EnqueuedReview>) {
    const enqueues: PullRequestTarget[] = []
    const flow = openFlow({
      deps: {
        readQueue: async () => ({ ...emptyQueue(), holder: { pid: 4242 } }),
        enqueueReview: (target) => {
          enqueues.push(target)
          return enqueued()
        },
      },
    })
    const toQueue = async () => {
      await flow.fromPalette()
      await flow.type('acme/shop#12')
      await flow.press(KEYS.enter)
      await flow.showing('Put in the queue')
      await flow.press(KEYS.down, KEYS.enter)
      await flow.showing('@ana')
      await flow.press(KEYS.enter)
      await flow.until(() => enqueues.length === 1)
    }
    return { ...flow, enqueues, toQueue }
  }

  it('puts the review in the queue when a watch runs, and opens the Queue with Enter', async () => {
    const flow = watching(async () => ({
      status: 'submitted',
      result: { status: 'queued', job: job(), requestId: 3 },
    }))
    const { asked, enqueues, frame, footer, fromPalette, press, showing, type } = flow
    await fromPalette()
    await type('acme/shop#12')
    await press(KEYS.enter)
    await showing('Put in the queue')
    expect(frame()).toMatch(/Put in the queue\s+the watch \(PID 4242\) reviews and publishes it/)
    expect(frame()).not.toContain('Review and publish')
    expect(frame()).toContain('Only look')
    expectFits(frame(), { columns: 80, rows: 24 })
    await press(KEYS.down, KEYS.enter)
    await showing('@ana')
    expect(frame()).toContain('Put the pull request in the queue? The watch publishes the review.')
    expect(frame()).toMatch(/Watch\s+running \(PID 4242\)/)
    expect(footer()).toContain('Enter put in the queue')
    expectFits(frame(), { columns: 80, rows: 24 })
    await press(KEYS.enter)
    await flow.until(() => enqueues.length === 1)
    expect(enqueues).toEqual([TARGET])
    await showing('Queued as job 7')
    expect(frame()).toContain('Queued as job 7 at a1b2c3d: the watch reviews and publishes it.')
    expect(footer()).toContain('Enter open the Queue')
    expect(footer()).toContain('Esc back')
    expect(asked).toEqual([])
    expectFits(frame(), { columns: 80, rows: 24 })
    await press(KEYS.enter)
    await showing('Watch running · PID 4242')
    expect(frame()).toMatch(/Home\s+Repos\s+Rules\s+Reviews\s+\[?Queue/)
  })

  it.each([
    [
      'a joined job',
      { status: 'submitted', result: { status: 'joined', job: job({ id: 5 }), requestId: 4 } },
      'Joined job 5 at a1b2c3d, already in the queue: the watch reviews and publishes it.',
    ],
    [
      'a refusal',
      { status: 'submitted', result: { status: 'refused', reason: 'not-watched' } },
      'Not queued: the repository is not listed under watch: in the user config.',
    ],
    [
      'the refusal of the when command',
      {
        status: 'submitted',
        result: { status: 'refused', reason: 'when-command', message: 'not \u001B[2Jtoday' },
      },
      'Not queued: the when command refused it (not [2Jtoday).',
    ],
    [
      'the hourly limit',
      {
        status: 'submitted',
        result: { status: 'refused', reason: 'hourly-limit', until: '2026-10-25T13:00:00.000Z' },
      },
      'Not queued: the hourly limit of new reviews is reached until',
    ],
    ['no token', { status: 'no-token' }, 'No GitHub token — gh auth login or set GITHUB_TOKEN'],
  ] as const)('shows %s', async (_case, enqueued, text) => {
    const flow = watching(async () => enqueued as EnqueuedReview)
    await flow.toQueue()
    await flow.until(() => flatFrame(flow.frame()).includes(text))
    expect(flatFrame(flow.frame())).toContain(text)
    expect(flow.frame()).not.toContain('\u001B[2J')
    expectFits(flow.frame(), { columns: 80, rows: 24 })
  })

  it('shows the error of a queue it cannot use, as without watch: in the config', async () => {
    const flow = watching(() =>
      Promise.reject(new Error('Nothing to watch: list the repositories under watch:')),
    )
    await flow.toQueue()
    await flow.showing('Nothing to watch')
    expect(flow.frame()).toContain('Could not put it in the queue.')
    expect(flow.frame()).toContain('Nothing to watch: list the repositories under watch:')
    await flow.press(KEYS.escape)
    await flow.showing('Review pull requests with the AI you already use.')
  })

  it.each([
    ['failed', () => Promise.reject(new Error('history unreadable'))],
    ['still loading', () => new Promise<never>(() => undefined)],
  ] as const)(
    'puts it in the queue when the queue read %s and a watch holds the lock at publishing',
    async (_case, readQueue) => {
      const enqueues: PullRequestTarget[] = []
      const flow = openFlow({
        deps: {
          readQueue,
          enqueueReview: async (target) => {
            enqueues.push(target)
            return { status: 'no-token' }
          },
        },
      })
      await flow.fromPalette()
      await flow.type('acme/shop#12')
      await flow.press(KEYS.enter)
      await flow.showing('Review and publish')
      await flow.press(KEYS.down, KEYS.enter)
      await flow.showing('Publish the review on GitHub?')
      await flow.showing('@ana')
      await flow.press(KEYS.enter)
      await flow.until(() => flow.asked.length === 1)
      flow.asked[0]?.resolve({ status: 'watch-running', pid: 4242 })
      await flow.showing('Put the pull request in the queue? The watch publishes the review.')
      expect(flow.frame()).toMatch(/Watch\s+running \(PID 4242\)/)
      expectFits(flow.frame(), { columns: 80, rows: 24 })
      await flow.press(KEYS.enter)
      await flow.until(() => enqueues.length === 1)
      expect(enqueues).toEqual([TARGET])
      expect(flow.asked).toHaveLength(1)
    },
  )

  it('still only looks here when a watch runs', async () => {
    const flow = watching(async () => ({ status: 'no-token' }))
    await flow.fromPalette()
    await flow.type('acme/shop#12')
    await flow.press(KEYS.enter)
    await flow.showing('Put in the queue')
    await flow.press(KEYS.enter)
    await flow.until(() => flow.asked.length === 1)
    expect(flow.asked[0]).toMatchObject({ target: TARGET, mode: 'look' })
    expect(flow.enqueues).toEqual([])
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
    ['pt', 'Revisar um pull request', 'Como a Phada deve revisar?', 'Só ver', 'Pôr na fila'],
    [
      'es',
      'Revisar un pull request',
      '¿Cómo debe revisarlo Phada?',
      'Solo ver',
      'Poner en la cola',
    ],
  ])('is translated (%s)', async (language, title, question, look, queue) => {
    const { frame, press, showing, type } = openFlow({
      language,
      deps: { readQueue: async () => ({ ...emptyQueue(), holder: { pid: 4242 } }) },
    })
    await showing('Phada')
    await press('/')
    await type(title.slice(0, 9).toLowerCase())
    await press(KEYS.enter)
    await showing('Pull request:')
    expect(frame()).toContain(title)
    await type('acme/shop#12')
    await press(KEYS.enter)
    await showing(question)
    await showing(queue)
    expect(frame()).toContain(look)
    expect(frame()).toContain(queue)
    expectFits(frame(), { columns: 80, rows: 24 })
  })
})
