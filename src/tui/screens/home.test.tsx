import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { AutomationView } from '../../app/read-automation.js'
import type { GitHubAccess } from '../../app/read-home.js'
import type { ProviderReport } from '../../app/read-provider.js'
import type { QueueView } from '../../app/read-queue.js'
import type { RepositoryList } from '../../app/read-repositories.js'
import {
  claudeSetup,
  configuredAutomation,
  FOUND_GITHUB,
  homeJob,
  homeRepositories,
  homeRun,
  loggedInClaude,
  minutesAgo,
  providerReport,
  runningQueue,
  watchedRepository,
} from '../../../test/support/home.js'
import {
  emptyAutomation,
  frameLines,
  KEYS,
  renderApp,
  visibleWidth,
  waitFor,
  CONFIG_ERROR_REASON,
  flatFrame,
  LONG_CONFIG_ERROR,
} from '../../../test/support/tui.js'
import type { AppDeps } from '../app-context.js'
import { FLAP_MS } from '../mascot.js'
import type { TerminalSize } from '../terminal-size.js'

afterEach(() => cleanup())

const NARROW = { columns: 80, rows: 24 }
const WIDE = { columns: 160, rows: 40 }
const RUNS = [1, 2, 3, 4, 5].map((number) =>
  homeRun(number, number === 2 ? { verdict: 'clean', findings: 0, score: 5 } : {}),
)

interface HomeOptions {
  size?: TerminalSize
  language?: string
  cwd?: string
  automation?: () => Promise<AutomationView>
  queue?: () => Promise<QueueView>
  repositories?: () => Promise<RepositoryList>
  github?: () => Promise<GitHubAccess>
  providers?: () => Promise<ProviderReport>
  deps?: Partial<AppDeps>
}

function openHome(options: HomeOptions = {}) {
  const calls = { github: 0, providers: 0, queue: 0 }
  const rendered = renderApp({
    size: options.size ?? NARROW,
    deps: {
      ...(options.language === undefined ? {} : { language: options.language }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      readAutomation: options.automation ?? (async () => configuredAutomation()),
      readQueue: async () => {
        calls.queue += 1
        return (options.queue ?? (async () => runningQueue()))()
      },
      readRepositories:
        options.repositories ??
        (async () =>
          homeRepositories([
            watchedRepository('acme/shop', true),
            watchedRepository('acme/web', true),
          ])),
      readReviews: async ({ limit }) => ({ runs: RUNS.slice(0, limit), total: 12 }),
      readProviderSetup: async () => claudeSetup(),
      readGitHub: async () => {
        calls.github += 1
        return (options.github ?? (async () => FOUND_GITHUB))()
      },
      readProviders: async () => {
        calls.providers += 1
        return (options.providers ?? (async () => providerReport([loggedInClaude()])))()
      },
      ...options.deps,
    },
  })
  return { ...rendered, calls }
}

function expectFits(frame: string, columns: number) {
  for (const line of frameLines(frame)) expect(visibleWidth(line)).toBeLessThanOrEqual(columns)
}

const never = () => new Promise<never>(() => {})

describe('the Home screen', () => {
  it('shows each status in one line, the last reviews and the recommendation in 80×24', async () => {
    const { frame, showing } = openHome()
    await showing('All set', 'Last reviews', 'acme/shop#3', /Watch +● running/, /Graph +●/)
    const text = frame()
    expect(text).toContain('Phada v1.2.3')
    expect(text).toContain('~/code/shop')
    expect(text).toMatch(/GitHub +● GITHUB_TOKEN · ana/)
    expect(text).toMatch(/AI +● Claude Code · opus · logged in/)
    expect(text).toMatch(/Watch +● running · PID 4242 · last cycle 2m ago · next in ~3m/)
    expect(text).toMatch(/Queue +○ empty/)
    expect(text).toMatch(/Graph +● 2 watched repositories indexed/)
    expect(text).toContain('All set: review a pull request')
    expect(text).toContain('phada review owner/repo#N')
    expect(text).toContain('Last reviews')
    expect(text).toContain('acme/shop#1')
    expect(text).toContain('acme/shop#3')
    expect(text).toContain('clean')
    expect(frameLines(text)).toHaveLength(24)
    expectFits(text, 80)
  })

  it('keeps the box whole at 80 columns, cutting a long folder with …', async () => {
    const { frame } = openHome({
      cwd: '/home/ana/code/a-very-long-folder-name/with/many/levels/below/it/until/the/project',
    })
    await waitFor(() => frame().includes('All set'))
    const lines = frameLines(frame())
    const top = lines.findIndex((line) => line.includes('╭'))
    const box = lines.slice(top, top + 6)
    expect(box[0]?.trimEnd().endsWith('╮')).toBe(true)
    expect(box[5]?.trimEnd().endsWith('╯')).toBe(true)
    for (const line of box.slice(1, 5)) expect(line.trimEnd().endsWith('│')).toBe(true)
    expect(frame()).toMatch(/ …[^ ]*\/until\/the\/project +│/)
    expectFits(frame(), 80)
  })

  it('shows five reviews in a wide terminal', async () => {
    const { frame } = openHome({ size: WIDE })
    await waitFor(() => frame().includes('All set') && frame().includes('acme/shop#5'))
    expect(frame()).toContain('acme/shop#5')
    const row = frameLines(frame()).find((line) => line.includes('Change number 5')) ?? ''
    expect(visibleWidth(row.trimEnd())).toBeLessThan(120)
    expectFits(frame(), 160)
  })

  it('counts the queue: running, queued, waiting for CI, failed and paused', async () => {
    const { frame } = openHome({
      size: WIDE,
      queue: async () => ({
        ...runningQueue(),
        running: [{ job: homeJob(1, { status: 'running' }), requests: [] }],
        queue: [
          { job: homeJob(2), requests: [] },
          { job: homeJob(3), requests: [] },
          { job: homeJob(4, { status: 'waiting' }), requests: [] },
        ],
        failed: [
          { job: homeJob(5, { status: 'failed', finishedAt: minutesAgo(10) }), requests: [] },
          { job: homeJob(6, { status: 'failed', finishedAt: minutesAgo(3000) }), requests: [] },
        ],
        pause: { until: '2026-10-25T13:00:00.000Z', reason: 'rate-limit', streak: 1 },
      }),
    })
    await waitFor(() => frame().includes('paused') && frame().includes('phada watch --status'))
    expect(frame()).toMatch(
      /Queue +○ 1 running · 2 queued · 1 waiting for CI · 1 failed · paused until .*\(in 1h\)/,
    )
    expect(frame()).toContain('The watch is paused until')
    expect(frame()).toContain('phada watch --status')
    expectFits(frame(), 160)
  })

  it('names the watched repositories without an index and asks to index them', async () => {
    const { frame } = openHome({
      repositories: async () =>
        homeRepositories([
          watchedRepository('acme/shop', true),
          watchedRepository('acme/web', false),
        ]),
    })
    await waitFor(() => frame().includes('phada index') && frame().includes('without index'))
    expect(frame()).toMatch(/Graph +○ 1 watched repository indexed · 1 without index/)
    expect(frame()).toContain('phada index acme/web')
  })

  it('asks for the missing Slack token instead of starting a watch that would refuse', async () => {
    const { frame } = openHome({
      queue: async () => ({ ...runningQueue(), holder: null, nextCycle: null }),
      automation: async () => ({
        ...configuredAutomation(),
        sources: {
          ...configuredAutomation().sources,
          slack: {
            channels: [{ id: 'C0123ABCD', publish: 'pr', reply: 'link' }],
            tokens: {
              bot: { variable: 'PHADA_SLACK_BOT_TOKEN', set: true },
              app: { variable: 'PHADA_SLACK_APP_TOKEN', set: false },
            },
          },
        },
      }),
    })
    await waitFor(() => frame().includes('for Slack'))
    expectFits(frame(), NARROW.columns)
    expect(frame()).toContain('→ Set PHADA_SLACK_APP_TOKEN for Slack')
    expect(frame()).toContain('export PHADA_SLACK_APP_TOKEN=xapp-…')
    expect(frame()).not.toContain('start it')
  })

  it('opens without config, history or token and says what is missing', async () => {
    const { frame } = openHome({
      automation: async () => emptyAutomation(),
      queue: async () => ({
        ...runningQueue(),
        recorded: false,
        holder: null,
        nextCycle: null,
        lastCycleAt: null,
      }),
      repositories: async () => ({ ...homeRepositories([]), configured: false, watching: false }),
      github: async () => ({ source: null }),
      deps: { readReviews: async () => ({ runs: [], total: 0 }) },
    })
    await waitFor(
      () =>
        frame().includes('gh auth login') &&
        frame().includes('No reviews yet.') &&
        /Watch +○ not configured/.test(frame()) &&
        /Graph +○ no watched repositories/.test(frame()),
    )
    const text = frame()
    expect(text).toMatch(/GitHub +○ no token/)
    expect(text).toContain('Phada needs a GitHub token')
    expect(text).toMatch(/Watch +○ not configured/)
    expect(text).toMatch(/Graph +○ no watched repositories/)
    expect(text).toContain('No reviews yet.')
    expectFits(text, 80)
  })

  it('recommends the setup without a user config', async () => {
    const { frame, showing } = openHome({ automation: async () => emptyAutomation() })
    await showing('phada setup')
    expect(frame()).toContain('Set up Phada')
    expect(frame()).not.toContain('phada init --global')
  })

  it('shows a long config error whole, wrapped over a few lines, in 80×24', async () => {
    const { frame } = openHome({
      automation: async () => ({
        ...emptyAutomation(),
        configured: true,
        configError: LONG_CONFIG_ERROR,
      }),
      deps: {
        readProviderSetup: async () => {
          throw new Error(LONG_CONFIG_ERROR)
        },
      },
    })
    await waitFor(() => flatFrame(frame()).includes(CONFIG_ERROR_REASON))
    expect(flatFrame(frame())).toContain(CONFIG_ERROR_REASON)
    expect(frame()).toContain('Fix the config file ~/.config/phada/config.yml')
    expectFits(frame(), 80)
    expect(frameLines(frame())).toHaveLength(24)
  })

  it('names the invalid config file and its error', async () => {
    const { frame } = openHome({
      automation: async () => ({
        ...emptyAutomation(),
        configured: true,
        configError: 'watch.interval: expected a duration like 5m',
      }),
      deps: {
        readProviderSetup: async () => {
          throw new Error('watch.interval: expected a duration like 5m')
        },
      },
    })
    await waitFor(
      () =>
        frame().includes('Fix the config file') &&
        frame().includes('watch.interval: expected a duration like 5m'),
    )
    expect(frame()).toContain('Fix the config file ~/.config/phada/config.yml')
    expect(frame()).toContain('watch.interval: expected a duration like 5m')
    expectFits(frame(), 80)
  })

  it('says what it is checking while slow reads load, flapping, and never says all is well', async () => {
    const { frame, clock } = openHome({ providers: never })
    await waitFor(
      () =>
        frame().includes('Checking the AI') && /AI +… Claude Code · opus · checking…/.test(frame()),
    )
    expect(frame()).toMatch(/AI +… Claude Code · opus · checking…/)
    expect(frame()).not.toContain('All set')
    const before = frame()
    clock.advance(FLAP_MS)
    await waitFor(() => frame() !== before)
    expect(frame()).toContain('▐█┃█▌')
  })

  it('shows errors on screen without breaking: network down, a check that failed', async () => {
    const { frame } = openHome({
      github: async () => ({
        source: 'gh',
        account: { state: 'failed', error: 'Could not reach GitHub: fetch failed' },
      }),
      providers: async () => {
        throw new Error('spawn failed')
      },
    })
    await waitFor(() => frame().includes('fetch failed') && frame().includes('spawn failed'))
    expect(frame()).toMatch(/GitHub +✗ gh login · Could not reach GitHub: fetch failed/)
    expect(frame()).toMatch(/AI +✗ Claude Code · opus · Could not load: spawn failed/)
    expectFits(frame(), 80)
  })

  it('draws the error of a provider check on one line, without control characters', async () => {
    const { frame } = openHome({
      providers: async () => {
        throw new Error('spawn failed:\n  \u001B[2J\u202Eagain')
      },
    })
    await waitFor(() => frame().includes('spawn failed'))
    expect(frame()).toMatch(/AI +✗ Claude Code · opus · Could not load: spawn failed: \[2Jagain/)
    expect(frame()).not.toMatch(/\u202E|\u001B\[2J/)
  })

  it('reads local data every 2 s and the slow parts only on open and on r', async () => {
    const { frame, clock, press, showing, calls } = openHome()
    await showing('All set', 'r refresh')
    expect(calls).toMatchObject({ github: 1, providers: 1 })
    const queueReads = calls.queue
    for (let tick = 1; tick <= 3; tick += 1) {
      clock.advance(2000)
      await waitFor(() => calls.queue === queueReads + tick)
    }
    expect(calls.queue).toBe(queueReads + 3)
    expect(calls).toMatchObject({ github: 1, providers: 1 })
    expect(frame()).toContain('r refresh')
    await press('r')
    await waitFor(() => calls.github === 2 && calls.providers === 2)
    await showing('All set')
    expect(calls).toMatchObject({ github: 2, providers: 2 })
  })

  it('shares the AI check with the Provider screen and shows the last facts at once on return', async () => {
    const { frame, press, showing, resize, calls } = openHome()
    await showing('All set', 'r refresh')
    await press('7')
    await showing('AI providers', 'Claude Code')
    expect(frame()).not.toContain('checking')
    await press('1')
    await showing('All set')
    expect(frame()).toContain('All set')
    expect(frame()).not.toContain('checking')
    resize({ columns: 70, rows: 20 })
    await showing('The terminal is 70×20')
    resize(NARROW)
    await showing('All set')
    expect(frame()).toContain('All set')
    expect(calls).toMatchObject({ github: 1, providers: 1 })
  })

  it('names a token GitHub refused and the next step of the chosen AI', async () => {
    const { frame } = openHome({
      github: async () => ({ source: 'GH_TOKEN', account: { state: 'refused' } }),
    })
    await waitFor(
      () =>
        frame().includes('refused') && frame().includes('GitHub refused the token from GH_TOKEN'),
    )
    expect(frame()).toMatch(/GitHub +✗ GH_TOKEN · refused by GitHub/)
    expect(frame()).toContain('GitHub refused the token from GH_TOKEN')

    cleanup()
    const ai = openHome({
      providers: async () =>
        providerReport([
          {
            ...loggedInClaude(),
            login: { state: 'logged-out' },
            next: { kind: 'login', command: 'claude auth login' },
          },
        ]),
    })
    await waitFor(
      () =>
        ai.frame().includes('claude auth login') && ai.frame().includes('Log in to Claude Code'),
    )
    expect(ai.frame()).toMatch(/AI +○ Claude Code · opus · logged out/)
    expect(ai.frame()).toContain('Log in to Claude Code')
  })

  it.each([
    ['pt', /Fila +○ vazia/, 'Tudo pronto: revise um pull request', 'Últimos reviews'],
    ['es', /Cola +○ vacía/, 'Todo listo: revisa un pull request', 'Últimas revisiones'],
  ])('is translated (%s)', async (language, queue, recommendation, reviews) => {
    const { frame } = openHome({ language, size: WIDE })
    await waitFor(
      () => frame().includes(recommendation) && frame().includes(reviews) && queue.test(frame()),
    )
    expect(frame()).toMatch(queue)
    expect(frame()).toContain(reviews)
    expectFits(frame(), 160)
  })

  it('fits 80×24 in every language with every line filled', async () => {
    for (const language of ['en', 'pt', 'es']) {
      const { frame } = openHome({
        language,
        queue: async () => ({
          ...runningQueue(),
          running: [{ job: homeJob(1, { status: 'running' }), requests: [] }],
          queue: [{ job: homeJob(4, { status: 'waiting' }), requests: [] }],
          failed: [
            {
              job: homeJob(5, {
                status: 'failed',
                error: 'x'.repeat(200),
                finishedAt: minutesAgo(10),
              }),
              requests: [],
            },
          ],
          pause: { until: '2026-10-25T13:00:00.000Z', reason: 'usage-limit', streak: 1 },
        }),
      })
      await waitFor(() => frame().includes('phada watch --status'))
      expect(frameLines(frame())).toHaveLength(24)
      expectFits(frame(), 80)
      cleanup()
    }
  })

  it('moves with the keys of the shell', async () => {
    const { frame, press, showing } = openHome()
    await showing('All set', 'r refresh')
    await press(KEYS.right)
    await showing('Enter open')
    expect(frame()).not.toContain('All set')
  })
})
