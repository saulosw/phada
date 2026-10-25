import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { ConfigError } from '../config/errors.js'
import type { HistoryStore, RunRecord } from '../store/history-store.js'
import type { AppDeps, AppHost, AppResult } from '../tui/open-app.js'
import { runApp } from './app-command.js'
import type { AppCommandDeps } from './app-command.js'
import { UsageError } from './errors.js'

function terminal(isTTY: boolean) {
  return {
    stdin: Object.assign(Readable.from([]), { isTTY }),
    stdout: { write: () => true, isTTY },
  }
}

function deps(
  options: {
    stdin?: boolean
    stdout?: boolean
    config?: string
    files?: Record<string, string>
    env?: Record<string, string>
    result?: AppResult
    history?: HistoryStore
    holder?: number
    observed?: AppCommandDeps['observed']
    during?: (deps: AppDeps) => Promise<void>
  } = {},
) {
  const opened: { deps: AppDeps; host: AppHost }[] = []
  const historyPaths: string[] = []
  const files = memoryFiles({
    ...(options.config === undefined ? {} : { '/cfg/config.yml': options.config }),
    ...options.files,
  })
  const app: AppCommandDeps = {
    env: { PHADA_CONFIG_HOME: '/cfg', TERM: 'xterm', ...options.env },
    home: '/home/ana',
    cwd: '/home/ana/shop',
    version: '1.2.3',
    files,
    stdin: terminal(options.stdin ?? true).stdin,
    stdout: terminal(options.stdout ?? true).stdout,
    onSignal: () => {},
    loadApp: async () => ({
      openApp: async (appDeps, host) => {
        opened.push({ deps: appDeps, host })
        await options.during?.(appDeps)
        return options.result ?? { kind: 'quit' }
      },
    }),
    clock: () => new Date('2026-10-25T12:00:00.000Z'),
    lockHolder: async (path) => (path === '/data/watch.lock' ? options.holder : undefined),
    openHistoryStore: async (path) => {
      historyPaths.push(path)
      if (options.history === undefined) throw new Error('no history')
      return options.history
    },
    pathSize: async (path) => (files.files.get(path)?.length ?? 0) * 1000,
    providerCheckers: {
      claude: async () => ({
        provider: 'claude',
        install: { state: 'installed', version: '2.1.0' },
        login: { state: 'logged-out' },
      }),
      codex: async () => ({
        provider: 'codex',
        install: { state: 'missing' },
        login: { state: 'unknown', problem: 'not-installed' },
      }),
      ollama: async () => ({ provider: 'ollama', baseUrl: null, server: { state: 'stopped' } }),
    },
    ...(options.observed === undefined ? {} : { observed: options.observed }),
  }
  app.env.PHADA_DATA_HOME = '/data'
  return { app, opened, files, historyPaths }
}

const MISSING = new UsageError('Missing the command, e.g. phada review owner/repo#123.')

describe('runApp', () => {
  it.each([
    [false, true],
    [true, false],
    [false, false],
  ])(
    'keeps the error of a missing command when stdin is a TTY: %s, stdout: %s',
    async (stdin, stdout) => {
      const { app, opened } = deps({ stdin, stdout })
      await expect(runApp(app)).rejects.toEqual(MISSING)
      expect(opened).toEqual([])
    },
  )

  it('opens the app in a terminal with the version, the folder and the signals', async () => {
    const { app, opened } = deps()
    expect(await runApp(app)).toBe(0)
    expect(opened).toHaveLength(1)
    expect(opened[0]?.deps).toMatchObject({
      version: '1.2.3',
      cwd: '/home/ana/shop',
      home: '/home/ana',
      env: { TERM: 'xterm' },
    })
    expect(opened[0]?.deps).not.toHaveProperty('language')
    expect(opened[0]?.host.stdin).toBe(app.stdin)
    expect(opened[0]?.host.stdout).toBe(app.stdout)
    expect(opened[0]?.host.onSignal).toBe(app.onSignal)
  })

  it('passes the language of the user config', async () => {
    const { app, opened } = deps({ config: 'language: pt-BR\n' })
    await runApp(app)
    expect(opened[0]?.deps.language).toBe('pt-BR')
  })

  it('still opens with an invalid user config, keeping its error for the screens', async () => {
    const { app, opened } = deps({ config: 'language: [1\n' })
    expect(await runApp(app)).toBe(0)
    expect(opened[0]?.deps.language).toBeUndefined()
    expect(opened[0]?.deps.configError).toBeInstanceOf(ConfigError)
  })

  it('reads the repositories and the automations from the user config folder and the cache', async () => {
    const { app, opened } = deps({
      config: 'watch:\n  repos: [acme/shop]\nslack:\n  channels: [C0123ABCD]\n',
      files: {
        '/cfg/repos/acme/api/config.yml': 'verify: false\n',
        '/cache/index/acme/shop.sqlite': 'db',
      },
      env: { PHADA_CACHE_HOME: '/cache', PHADA_SLACK_BOT_TOKEN: 'xoxb-secret' },
      during: async (appDeps) => {
        const list = await appDeps.readRepositories()
        expect(list.configFile).toBe('/cfg/config.yml')
        expect(
          list.repositories.map(({ repo, origins, index }) => [repo, origins, index.file]),
        ).toEqual([
          ['acme/api', ['own-config'], null],
          ['acme/shop', ['watched'], { path: '/cache/index/acme/shop.sqlite', bytes: 2000 }],
        ])
        const detail = await appDeps.readRepository('acme/api')
        expect(detail.config.status === 'read' && detail.config.settings).toContainEqual({
          key: 'verify',
          value: { kind: 'flag', on: false },
          origin: 'repository',
        })
        const automation = await appDeps.readAutomation()
        expect(automation.sources.slack?.tokens).toEqual({ bot: true, app: false })
        expect(JSON.stringify(automation)).not.toContain('xoxb-secret')
      },
    })
    expect(await runApp(app)).toBe(0)
    expect(opened).toHaveLength(1)
  })

  it.each([
    [{ kind: 'quit' }, 0],
    [{ kind: 'interrupted' }, 130],
    [{ kind: 'terminated' }, 143],
  ] as const)('turns %j into the exit code %d', async (result, code) => {
    expect(await runApp(deps({ result }).app)).toBe(code)
  })

  it('throws the error the app failed with, after it closed', async () => {
    const failure = new Error('boom')
    await expect(runApp(deps({ result: { kind: 'failed', error: failure } }).app)).rejects.toBe(
      failure,
    )
  })

  it('ticks a real scheduler until it is stopped', async () => {
    const { app, opened } = deps()
    await runApp(app)
    const ticks: number[] = []
    const stop = opened[0]?.deps.scheduler.every(1, () => ticks.push(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    stop?.()
    const seen = ticks.length
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen).toBeGreaterThan(0)
    expect(ticks).toHaveLength(seen)
  })

  it('reads the queue and the reviews from the history once its file appears, and closes it after the app', async () => {
    const store = fakeHistory([{ ...RUN, id: 7 }])
    const seen: unknown[] = []
    const { app, files, historyPaths } = deps({
      config: 'watch:\n  repos: [acme/shop]\n  maxReviewsPerHour: 4\n',
      history: store,
      holder: 4242,
      during: async (appDeps) => {
        seen.push((await appDeps.readReviews({})).total)
        seen.push((await appDeps.readQueue()).recorded)
        files.files.set('/data/history.sqlite', '')
        seen.push((await appDeps.readReviews({ text: 'shop' })).runs.map((run) => run.id))
        const queue = await appDeps.readQueue()
        seen.push(queue.holder, queue.hourly, queue.recorded)
        seen.push((await appDeps.readReviewDetail(7))?.pullRequest.url)
        seen.push(appDeps.now().toISOString())
        expect(store.closed).toBe(0)
      },
    })

    await runApp(app)

    expect(seen).toEqual([
      0,
      false,
      [7],
      { pid: 4242 },
      { count: 0, max: 4 },
      true,
      'https://github.com/acme/shop/pull/3',
      '2026-10-25T12:00:00.000Z',
    ])
    expect(historyPaths).toEqual(['/data/history.sqlite'])
    expect(store.texts).toEqual(['shop'])
    expect(store.closed).toBe(1)
  })

  it('never opens a history that does not exist', async () => {
    const { app, historyPaths } = deps({
      during: async (appDeps) => {
        expect(await appDeps.readQueue()).toMatchObject({ recorded: false, holder: null })
        expect(await appDeps.readReviewDetail(1)).toBeUndefined()
      },
    })
    await runApp(app)
    expect(historyPaths).toEqual([])
  })
})

describe('the provider and learnings readers', () => {
  it('read the provider chosen in the user config, its MCP servers and the checked providers', async () => {
    const seen: unknown[] = []
    const { app } = deps({
      config: 'provider: codex\nmcp:\n  - github\n',
      during: async (appDeps) => {
        seen.push(await appDeps.readProviderSetup())
        const report = await appDeps.readProviders()
        seen.push(report.providers.map(({ provider, chosen }) => [provider, chosen]))
      },
    })
    await runApp(app)
    expect(seen).toEqual([
      {
        choice: {
          provider: 'codex',
          model: null,
          origin: { kind: 'user-config', path: '/cfg/config.yml' },
        },
        mcp: [{ name: 'github', kind: 'named', tools: [], description: null }],
      },
      [
        ['claude', false],
        ['codex', true],
        ['ollama', false],
      ],
    ])
  })

  it('read the observed files of the cache folder, each by its own path', async () => {
    const lists: string[] = []
    const reads: string[] = []
    const { app } = deps({
      observed: {
        list: async (cacheDir) => {
          lists.push(cacheDir)
          return ['acme/shop', 'acme/web']
        },
        read: async (path) => {
          reads.push(path)
          return path.endsWith('shop.sqlite') ? [] : 'unreadable'
        },
      },
      during: async (appDeps) => {
        const learnings = await appDeps.readLearnings()
        expect(learnings.recorded).toBe(false)
        expect(learnings.repos.map(({ repo, observed }) => [repo, observed.state])).toEqual([
          ['acme/shop', 'read'],
          ['acme/web', 'unreadable'],
        ])
      },
    })
    app.env.PHADA_CACHE_HOME = '/cache'
    await runApp(app)
    expect(lists).toEqual(['/cache'])
    expect(reads.sort()).toEqual([
      '/cache/observed/acme/shop.sqlite',
      '/cache/observed/acme/web.sqlite',
    ])
  })
})

const RUN: RunRecord = {
  source: 'watch',
  repo: 'acme/shop',
  number: 3,
  headSha: 'a'.repeat(40),
  startedAt: '2026-10-25T11:00:00.000Z',
  finishedAt: '2026-10-25T11:02:00.000Z',
  status: 'published',
  aiCalled: true,
}

function fakeHistory(runs: RunRecord[]) {
  const store = {
    closed: 0,
    texts: [] as (string | undefined)[],
    close: () => {
      store.closed++
    },
    status: () => ({ repos: [], queued: [], running: [], failed: [], lastRuns: [] }),
    jobs: () => [],
    requests: () => [],
    watchRunsSince: () => [],
    runs: (filter: { text?: string }) => {
      store.texts.push(filter.text)
      return { runs: filter.text === undefined ? [] : runs, total: runs.length }
    },
    run: (id: number) => runs.find((run) => run.id === id),
    findings: () => [],
  }
  return store as typeof store & HistoryStore
}
