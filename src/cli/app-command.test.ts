import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { ConfigError } from '../config/errors.js'
import { HISTORY_MIGRATIONS } from '../store/history-migrations.js'
import { HistoryOutdatedError, openHistoryStore } from '../store/history-store.js'
import type { HistoryStore, RunRecord } from '../store/history-store.js'
import type { AppDeps, AppHost, AppResult } from '../tui/open-app.js'
import { runApp } from './app-command.js'
import type { AppCommandDeps, StopSignal } from './app-command.js'
import { UsageError } from './errors.js'
import { RULES_TEMPLATE, USER_CONFIG_TEMPLATE } from './init-templates.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { memoryMirror } from '../../test/support/memory-mirror.js'
import { createExtractor } from '../repo-map/extract.js'
import type { GitMirrorOptions } from '../repository/git-mirror.js'
import { CheckoutUnavailableError } from '../repository/git-checkout.js'
import { openIndexStore } from '../store/index-store.js'
import type { IndexingProgress } from '../app/index-repository.js'
import { reviewState } from '../../test/support/review-state.js'

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
    github?: FakeGitHub
    during?: (deps: AppDeps, host: AppHost) => Promise<void>
    runInteractive?: AppCommandDeps['runInteractive']
    ollamaFetch?: AppCommandDeps['ollamaFetch']
    ghToken?: string
    dataHome?: string
    openMirror?: AppCommandDeps['openMirror']
    openIndexReader?: AppCommandDeps['openIndexReader']
    openGraph?: AppCommandDeps['openGraph']
  } = {},
) {
  const ghCalls: string[][] = []
  const userTokens: string[] = []
  const opened: { deps: AppDeps; host: AppHost }[] = []
  const historyPaths: string[] = []
  const signalHandlers: ((signal?: StopSignal) => void)[] = []
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
    onSignal: (handler) => {
      signalHandlers.push(handler)
    },
    loadApp: async () => ({
      openApp: async (appDeps, host) => {
        opened.push({ deps: appDeps, host })
        await options.during?.(appDeps, host)
        return options.result ?? { kind: 'quit' }
      },
    }),
    clock: () => new Date('2026-10-25T12:00:00.000Z'),
    lockHolder: async (path) => (path === '/data/watch.lock' ? options.holder : undefined),
    ...(options.dataHome === undefined
      ? {
          openHistoryReader: async (path: string) => {
            historyPaths.push(path)
            if (options.history === undefined) throw new Error('no history')
            return options.history
          },
        }
      : {}),
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
    ...(options.openIndexReader === undefined ? {} : { openIndexReader: options.openIndexReader }),
    ...(options.openGraph === undefined ? {} : { openGraph: options.openGraph }),
    runGh: async (_command, args) => {
      ghCalls.push([...args])
      return options.ghToken === undefined
        ? { stdout: '', stderr: 'not logged in', exitCode: 1 }
        : { stdout: `${options.ghToken}\n`, stderr: '', exitCode: 0 }
    },
    fetchUser: async ({ token }) => {
      userTokens.push(token)
      return { login: 'ana' }
    },
    ...(options.github ?? fakeGitHub()).readers,
    ...(options.runInteractive === undefined ? {} : { runInteractive: options.runInteractive }),
    ...(options.ollamaFetch === undefined ? {} : { ollamaFetch: options.ollamaFetch }),
    openMirror:
      options.openMirror ?? (async () => memoryMirror({ 'src/a.ts': 'export const a = 1\n' })),
    openIndexStore: async () => openIndexStore(join(indexDir, `i${(stores += 1)}.sqlite`)),
    createExtractor,
  }
  app.env.PHADA_DATA_HOME = options.dataHome ?? '/data'
  const send = (signal: StopSignal) => {
    for (const handler of signalHandlers) handler(signal)
  }
  return { app, opened, files, historyPaths, ghCalls, userTokens, send }
}

const indexDir = mkdtempSync(join(tmpdir(), 'phada-app-index-'))
let stores = 0
afterAll(() => rmSync(indexDir, { recursive: true, force: true }))

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

  it.each([
    [false, true],
    [true, false],
  ])('refuses the setup when stdin is a TTY: %s, stdout: %s', async (stdin, stdout) => {
    const { app, opened } = deps({ stdin, stdout })
    await expect(runApp(app, { setup: true })).rejects.toEqual(
      new UsageError('phada setup needs an interactive terminal.'),
    )
    expect(opened).toEqual([])
  })

  it('opens on the setup while the user config file does not exist', async () => {
    const { app, opened } = deps()
    await runApp(app)
    expect(opened[0]?.deps.start).toBe('setup')
  })

  it('opens on the Home once the user config file exists, even empty', async () => {
    const { app, opened } = deps({ config: '' })
    await runApp(app)
    expect(opened[0]?.deps.start).toBe('home')
  })

  it('opens on the setup when asked, with a user config', async () => {
    const { app, opened } = deps({ config: 'language: pt\n' })
    await runApp(app, { setup: true })
    expect(opened[0]?.deps.start).toBe('setup')
  })

  it('plans a change to the user config and writes it with the commented template', async () => {
    const results: unknown[] = []
    const { app, files } = deps({
      during: async (appDeps) => {
        const planned = await appDeps.planConfig([{ kind: 'set', key: 'language', value: 'pt' }])
        results.push(planned)
        if (planned.ok) results.push(await appDeps.applyConfig(planned.plan))
      },
    })
    await runApp(app)
    expect(results).toEqual([
      {
        ok: true,
        plan: expect.objectContaining({
          path: '/cfg/config.yml',
          exists: false,
          changes: [{ key: 'language', before: null, after: 'pt' }],
        }),
      },
      { ok: true, written: true },
    ])
    expect(files.files.get('/cfg/config.yml')).toBe(`language: pt\n\n${USER_CONFIG_TEMPLATE}`)
  })

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
  })

  it('hands the app only the variables of the colors, never a token', async () => {
    const { app, opened } = deps({
      env: {
        NO_COLOR: '1',
        FORCE_COLOR: '2',
        COLORTERM: 'truecolor',
        GITHUB_TOKEN: 'ghp_env',
        PHADA_SLACK_BOT_TOKEN: 'xoxb-secret',
      },
    })
    await runApp(app)
    expect(opened[0]?.deps.env).toEqual({
      NO_COLOR: '1',
      FORCE_COLOR: '2',
      TERM: 'xterm',
      COLORTERM: 'truecolor',
    })
    expect(opened[0]?.deps.env).not.toBe(app.env)
  })

  it('passes the language of the user config', async () => {
    const { app, opened } = deps({ config: 'language: pt-BR\n' })
    await runApp(app)
    expect(opened[0]?.deps.language).toBe('pt-BR')
  })

  it('still opens with an invalid user config, its language read failing with the error', async () => {
    const { app, opened } = deps({ config: 'language: [1\n' })
    expect(await runApp(app)).toBe(0)
    expect(opened[0]?.deps.language).toBeUndefined()
    await expect(opened[0]?.deps.readLanguage()).rejects.toBeInstanceOf(ConfigError)
  })

  it('reads the language and the watch settings of the user config again on each read', async () => {
    const seen: unknown[] = []
    const { app, files } = deps({
      config: 'language: pt-BR\nwatch:\n  repos: [acme/shop]\n  maxReviewsPerHour: 4\n',
      history: fakeHistory([]),
      files: { '/data/history.sqlite': '' },
      during: async (appDeps) => {
        seen.push(await appDeps.readLanguage(), (await appDeps.readQueue()).hourly)
        files.files.set(
          '/cfg/config.yml',
          'language: es\nwatch:\n  repos: [acme/shop]\n  maxReviewsPerHour: 6\n',
        )
        seen.push(await appDeps.readLanguage(), (await appDeps.readQueue()).hourly)
        files.files.set('/cfg/config.yml', 'watch: [1\n')
        seen.push((await appDeps.readQueue()).hourly)
      },
    })

    await runApp(app)

    expect(seen).toEqual([
      'pt-BR',
      { count: 0, max: 4 },
      'es',
      { count: 0, max: 6 },
      { count: 0, max: 6 },
    ])
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
          ['acme/shop', ['watched'], { path: '/cache/index/acme/shop.sqlite', bytes: 2000 }],
          ['acme/api', ['own-config'], null],
        ])
        const detail = await appDeps.readRepository('acme/api')
        expect(detail.config.status === 'read' && detail.config.settings).toContainEqual({
          key: 'verify',
          value: { kind: 'flag', on: false },
          origin: 'repository',
        })
        const automation = await appDeps.readAutomation()
        expect(automation.sources.slack?.tokens).toEqual({
          bot: { variable: 'PHADA_SLACK_BOT_TOKEN', set: true },
          app: { variable: 'PHADA_SLACK_APP_TOKEN', set: false },
        })
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

describe('handing the terminal over', () => {
  type Run = NonNullable<AppCommandDeps['runInteractive']>
  type RunCall = { command: string; args: readonly string[]; options: Parameters<Run>[2] }

  function runner(result: (call: RunCall) => ReturnType<Run>) {
    const calls: RunCall[] = []
    const run: Run = (command, args, options) => {
      const call = { command, args, options }
      calls.push(call)
      return result(call)
    }
    return { run, calls }
  }

  function pending() {
    let finish: (exitCode: number) => void = () => {}
    const promise = new Promise<{ kind: 'exited'; exitCode: number }>((resolve) => {
      finish = (exitCode) => resolve({ kind: 'exited', exitCode })
    })
    return { promise, finish }
  }

  it('runs the command in the folder of the app with its environment, and gives back how it ended', async () => {
    const { run, calls } = runner(async () => ({ kind: 'exited', exitCode: 1 }))
    const results: unknown[] = []
    const { app } = deps({
      env: { GITHUB_TOKEN: 'ghp_x' },
      runInteractive: run,
      during: async (appDeps) => {
        results.push(
          await appDeps.handOff({ kind: 'command', command: 'gh', args: ['auth', 'login'] }),
        )
      },
    })
    await runApp(app)
    expect(results).toEqual([{ kind: 'exited', exitCode: 1 }])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      command: 'gh',
      args: ['auth', 'login'],
      options: { cwd: '/home/ana/shop', env: app.env },
    })
  })

  it.each([
    ['claude', 'claude', ['auth', 'login']],
    ['codex', 'codex', ['login']],
  ] as const)(
    'logs in to %s without the GitHub tokens of the environment',
    async (provider, command, args) => {
      const { run, calls } = runner(async () => ({ kind: 'exited', exitCode: 0 }))
      const { app } = deps({
        env: { GITHUB_TOKEN: 'ghp_x', GH_TOKEN: 'gho_y', HOME: '/home/ana', PATH: '/usr/bin' },
        runInteractive: run,
        during: async (appDeps) => {
          await appDeps.handOff({ kind: 'ai-login', provider })
        },
      })
      await runApp(app)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ command, args, options: { cwd: '/home/ana/shop' } })
      const { GITHUB_TOKEN: _github, GH_TOKEN: _gh, ...rest } = app.env
      expect(calls[0]?.options.env).toEqual(rest)
      expect(rest).toMatchObject({ HOME: '/home/ana', PATH: '/usr/bin' })
    },
  )

  it.each([
    [{ VISUAL: 'code --wait', EDITOR: 'nano' }, 'code', ['--wait']],
    [{ VISUAL: '  ', EDITOR: ' nano  -w ' }, 'nano', ['-w']],
    [{ EDITOR: 'emacs' }, 'emacs', []],
    [{}, 'vi', []],
  ])('opens a file in VISUAL, else EDITOR, else vi: %j', async (env, command, args) => {
    const { run, calls } = runner(async ({ command }) => ({ kind: 'not-found', command }))
    const results: unknown[] = []
    const { app } = deps({
      env,
      runInteractive: run,
      during: async (appDeps) => {
        results.push(await appDeps.handOff({ kind: 'editor', file: '/cfg/config.yml' }))
      },
    })
    await runApp(app)
    expect(calls.map(({ command, args }) => [command, args])).toEqual([
      [command, [...args, '/cfg/config.yml']],
    ])
    expect(results).toEqual([{ kind: 'not-found', command }])
  })

  it('stops reading the terminal before the command runs, so every key goes to the command', async () => {
    const events: string[] = []
    const { run } = runner(async () => {
      events.push('run')
      return { kind: 'exited', exitCode: 130 }
    })
    const appInput = () => {}
    const { app } = deps({
      runInteractive: run,
      during: async (appDeps, host) => {
        host.stdin.removeListener('readable', appInput)
        await appDeps.handOff({ kind: 'ai-login', provider: 'claude' })
      },
    })
    app.stdin.on('readable', appInput)
    app.stdin.on('pause', () => events.push('pause'))
    await runApp(app)
    expect(events).toEqual(['pause', 'run'])
  })

  it('returns the cursor to the start of the line after the command, where the app redraws', async () => {
    const events: string[] = []
    const { run } = runner(async () => {
      events.push('run')
      return { kind: 'exited', exitCode: 0 }
    })
    const { app } = deps({
      runInteractive: run,
      during: async (appDeps) => {
        await appDeps.handOff({ kind: 'ai-login', provider: 'codex' })
      },
    })
    app.stdout = {
      isTTY: true,
      write: (text: string) => {
        events.push(`write ${JSON.stringify(text)}`)
        return true
      },
    }
    await runApp(app)
    expect(events).toEqual(['run', 'write "\\r"'])
  })

  it('leaves Ctrl-C to the command while it runs, and ends the app on it afterwards', async () => {
    const child = pending()
    const { run } = runner(() => child.promise)
    const received: (StopSignal | undefined)[] = []
    const { app, send } = deps({
      runInteractive: run,
      during: async (appDeps, host) => {
        host.onSignal((signal) => received.push(signal))
        const handOff = appDeps.handOff({ kind: 'ai-login', provider: 'codex' })
        send('SIGINT')
        expect(received).toEqual([])
        child.finish(130)
        await handOff
        send('SIGINT')
      },
    })
    await runApp(app)
    expect(received).toEqual(['SIGINT'])
  })

  it('ends the app and the command on SIGTERM while the command runs', async () => {
    const child = pending()
    const { run, calls } = runner(() => child.promise)
    const received: (StopSignal | undefined)[] = []
    const { app, send } = deps({
      runInteractive: run,
      during: async (appDeps, host) => {
        host.onSignal((signal) => received.push(signal))
        const handOff = appDeps.handOff({ kind: 'ai-login', provider: 'codex' })
        await vi.waitFor(() => expect(calls).toHaveLength(1))
        expect(calls[0]?.options.signal?.aborted).toBe(false)
        send('SIGTERM')
        expect(received).toEqual(['SIGTERM'])
        expect(calls[0]?.options.signal?.aborted).toBe(true)
        child.finish(143)
        await handOff
      },
    })
    await runApp(app)
  })
})

describe('the history of the app', () => {
  it('reads a real history without changing it, and shows one of an older Phada as such', async () => {
    const dataHome = mkdtempSync(join(tmpdir(), 'phada-app-history-'))
    const path = join(dataHome, 'history.sqlite')
    try {
      ;(await openHistoryStore(path, { migrations: HISTORY_MIGRATIONS.slice(0, 1) })).close()
      let error: unknown
      const { app } = deps({
        dataHome,
        files: { [path]: '' },
        during: async (appDeps) => {
          error = await appDeps.readQueue().catch((thrown: unknown) => thrown)
        },
      })

      await runApp(app)

      expect(error).toBeInstanceOf(HistoryOutdatedError)
      expect((error as Error).message).toContain('run any phada command, such as phada history')
      const db = new DatabaseSync(path, { readOnly: true })
      expect(db.prepare('pragma user_version').get()?.user_version).toBe(1)
      expect(db.prepare('pragma journal_mode').get()?.journal_mode).toBe('wal')
      db.close()
    } finally {
      rmSync(dataHome, { recursive: true, force: true })
    }
  })
})

describe('the GitHub reader', () => {
  it('names where the token comes from and reads its owner, never handing over the token', async () => {
    const seen: unknown[] = []
    const { app, userTokens, ghCalls } = deps({
      env: { GH_TOKEN: 'ghp_env' },
      during: async (appDeps) => {
        seen.push(await appDeps.readGitHub())
      },
    })
    await runApp(app)
    expect(seen).toEqual([{ source: 'GH_TOKEN', account: { state: 'found', login: 'ana' } }])
    expect(JSON.stringify(seen)).not.toContain('ghp_env')
    expect(userTokens).toEqual(['ghp_env'])
    expect(ghCalls).toEqual([])
  })

  it('asks gh again on each read, so a login made meanwhile is seen', async () => {
    const seen: unknown[] = []
    const { app, ghCalls, userTokens } = deps({
      ghToken: 'gho_login',
      during: async (appDeps) => {
        seen.push(await appDeps.readGitHub())
        seen.push(await appDeps.readGitHub())
      },
    })
    await runApp(app)
    expect(seen).toEqual([
      { source: 'gh', account: { state: 'found', login: 'ana' } },
      { source: 'gh', account: { state: 'found', login: 'ana' } },
    ])
    expect(ghCalls.map((args) => args.slice(0, 2))).toEqual([
      ['auth', 'token'],
      ['auth', 'token'],
    ])
    expect(userTokens).toEqual(['gho_login', 'gho_login'])
  })

  it('gives the Home and the Rules the same token, read again on each load', async () => {
    let login: string | undefined
    const seen: unknown[] = []
    const { app } = deps({
      github: fakeGitHub(),
      during: async (appDeps) => {
        seen.push(await appDeps.readGitHub(), await appDeps.readRepositoryRules('acme/shop'))
        login = 'gho_login'
        seen.push((await appDeps.readGitHub()).source)
        seen.push((await appDeps.readRepositoryRules('acme/shop')).status)
      },
    })
    app.runGh = async () =>
      login === undefined
        ? { stdout: '', stderr: 'not logged in', exitCode: 1 }
        : { stdout: `${login}\n`, stderr: '', exitCode: 0 }

    await runApp(app)

    expect(seen).toEqual([{ source: null }, { status: 'no-token' }, 'gh', 'read'])
  })

  it('has no source without a token in the environment or gh', async () => {
    const seen: unknown[] = []
    const { app, userTokens } = deps({
      during: async (appDeps) => {
        seen.push(await appDeps.readGitHub())
      },
    })
    await runApp(app)
    expect(seen).toEqual([{ source: null }])
    expect(userTokens).toEqual([])
  })
})

describe('the user repositories reader', () => {
  it('lists the repositories of the token owner with the ones the user config watches', async () => {
    const seen: unknown[] = []
    const tokens: string[] = []
    const { app } = deps({
      config: 'watch:\n  repos:\n    - Acme/Shop\n    - other/lib\n',
      env: { GITHUB_TOKEN: 'ghp_env' },
      during: async (appDeps) => {
        seen.push(await appDeps.readUserRepositories())
      },
    })
    app.listRepositories = async ({ token }) => {
      tokens.push(token)
      return [
        { name: 'ana/ink', private: false, fork: true, pushedAt: null },
        { name: 'acme/shop', private: true, fork: false, pushedAt: '2026-10-26T18:00:00Z' },
      ]
    }

    await runApp(app)

    expect(tokens).toEqual(['ghp_env'])
    expect(seen).toEqual([
      {
        status: 'listed',
        repositories: [
          {
            name: 'acme/shop',
            private: true,
            fork: false,
            pushedAt: '2026-10-26T18:00:00Z',
            watched: true,
            listed: true,
          },
          { name: 'other/lib', watched: true, listed: false },
          {
            name: 'ana/ink',
            private: false,
            fork: true,
            pushedAt: null,
            watched: false,
            listed: true,
          },
        ],
      },
    ])
    expect(JSON.stringify(seen)).not.toContain('ghp_env')
  })

  it('says there is no token without listing', async () => {
    const seen: unknown[] = []
    const { app } = deps({
      during: async (appDeps) => {
        seen.push(await appDeps.readUserRepositories())
      },
    })
    app.listRepositories = async () => {
      throw new Error('listed without a token')
    }

    await runApp(app)

    expect(seen).toEqual([{ status: 'no-token', repositories: [] }])
  })
})

describe('the indexer', () => {
  function indexing(
    during: (appDeps: AppDeps) => Promise<void>,
    options: Parameters<typeof deps>[0] = {},
  ) {
    const mirrors: GitMirrorOptions[] = []
    const opened = deps({
      env: { GITHUB_TOKEN: 'ghp_env', PHADA_CACHE_HOME: '/cache' },
      during,
      openMirror: async (mirror) => {
        mirrors.push(mirror)
        return memoryMirror({
          'src/a.ts': 'export function a() {}\n',
          'src/b.ts': 'export function b() {}\n',
          'README.md': '# shop\n',
        })
      },
      ...options,
    })
    return { ...opened, mirrors }
  }

  it('indexes a repository in the mirror of the cache with the token, reporting each phase', async () => {
    const progress: IndexingProgress[] = []
    const seen: unknown[] = []
    const { app, mirrors } = indexing(async (appDeps) => {
      seen.push(
        await appDeps.indexRepository('acme/shop', {
          signal: new AbortController().signal,
          onProgress: (step) => progress.push(step),
        }),
      )
    })

    await runApp(app)

    expect(seen).toEqual([{ kind: 'indexed', files: 2 }])
    expect(mirrors).toEqual([
      expect.objectContaining({
        dir: '/cache/repos/acme/shop.git',
        owner: 'acme',
        repo: 'shop',
        token: 'ghp_env',
      }),
    ])
    expect(progress).toEqual([
      { phase: 'fetching' },
      { phase: 'extracting', done: 0, total: 2 },
      { phase: 'extracting', done: 1, total: 2 },
      { phase: 'extracting', done: 2, total: 2 },
    ])
  })

  it('stops when cancelled, saying how far it got', async () => {
    const seen: unknown[] = []
    const cancel = new AbortController()
    cancel.abort()
    const { app } = indexing(async (appDeps) => {
      seen.push(
        await appDeps.indexRepository('acme/shop', { signal: cancel.signal, onProgress: () => {} }),
      )
    })

    await runApp(app)

    expect(seen).toEqual([{ kind: 'cancelled', extracted: 0, total: 2 }])
  })

  it('gives a failure back as its message', async () => {
    const seen: unknown[] = []
    const { app } = indexing(
      async (appDeps) => {
        const options = { signal: new AbortController().signal, onProgress: () => {} }
        seen.push(await appDeps.indexRepository('acme/secret', options))
      },
      {
        env: { GITHUB_TOKEN: 'ghp_env' },
        openMirror: async () => {
          throw new CheckoutUnavailableError('no-access', 'Could not fetch HEAD from acme/secret')
        },
      },
    )
    await runApp(app)
    expect(seen).toEqual([{ kind: 'failed', message: 'Could not fetch HEAD from acme/secret' }])
  })

  it('says there is no token without fetching', async () => {
    const seen: unknown[] = []
    const { app, mirrors } = indexing(
      async (appDeps) => {
        const options = { signal: new AbortController().signal, onProgress: () => {} }
        seen.push(await appDeps.indexRepository('acme/shop', options))
      },
      { env: {} },
    )
    await runApp(app)
    expect(seen).toEqual([{ kind: 'no-token' }])
    expect(mirrors).toEqual([])
  })
})

describe('the repository of the folder', () => {
  it('finds the repository the app runs in and creates its .phada/ when asked', async () => {
    const seen: unknown[] = []
    const { app, files } = deps({
      during: async (appDeps) => {
        seen.push(await appDeps.readRepositoryFolder())
        seen.push(await appDeps.initRepository())
        seen.push(await appDeps.readRepositoryFolder())
      },
    })
    await files.makeDir('/home/ana/shop/.git')

    await runApp(app)

    expect(seen).toEqual([
      { kind: 'unconfigured', root: '/home/ana/shop' },
      {
        root: '/home/ana/shop',
        files: [
          { path: '.phada/config.yml', created: true },
          { path: '.phada/rules.md', created: true },
        ],
      },
      { kind: 'configured', root: '/home/ana/shop' },
    ])
    expect(files.files.has('/home/ana/shop/.phada/rules.md')).toBe(true)
  })

  it('says the folder of the app is outside a git repository', async () => {
    const seen: unknown[] = []
    const { app } = deps({
      during: async (appDeps) => {
        seen.push(await appDeps.readRepositoryFolder())
      },
    })
    await runApp(app)
    expect(seen).toEqual([{ kind: 'outside' }])
  })
})

describe('the files of a repository in the user config folder', () => {
  it('creates config.yml with a commented header and rules.md with the rules template when missing', async () => {
    const seen: string[] = []
    const { app, files } = deps({
      during: async (appDeps) => {
        seen.push(await appDeps.ensureRepositoryFile('Acme/Shop', 'config.yml'))
        seen.push(await appDeps.ensureRepositoryFile('acme/shop', 'rules.md'))
      },
    })
    await runApp(app)
    expect(seen).toEqual(['/cfg/repos/acme/shop/config.yml', '/cfg/repos/acme/shop/rules.md'])
    const config = files.files.get('/cfg/repos/acme/shop/config.yml') ?? ''
    expect(config).toMatch(/^# .*acme\/shop/)
    expect(config.split('\n').every((line) => line === '' || line.startsWith('#'))).toBe(true)
    expect(files.files.get('/cfg/repos/acme/shop/rules.md')).toBe(RULES_TEMPLATE)
  })

  it('leaves a file that exists as it is', async () => {
    const { app, files } = deps({
      files: { '/cfg/repos/acme/shop/config.yml': 'verify: false\n' },
      during: async (appDeps) => {
        await appDeps.ensureRepositoryFile('acme/shop', 'config.yml')
      },
    })
    await files.makeDir('/cfg/repos/acme/shop')
    await runApp(app)
    expect(files.files.get('/cfg/repos/acme/shop/config.yml')).toBe('verify: false\n')
  })

  it('refuses a name that would leave the folder of the repository', async () => {
    const errors: unknown[] = []
    const { app, files } = deps({
      during: async (appDeps) => {
        for (const repo of ['../etc', 'acme/..', 'acme/shop/extra', 'acme']) {
          await appDeps.ensureRepositoryFile(repo, 'rules.md').catch((error) => errors.push(error))
        }
      },
    })
    await runApp(app)
    expect(errors).toHaveLength(4)
    expect([...files.files.keys()]).toEqual([])
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

  it('pulls an Ollama model from the server OLLAMA_HOST names, with its progress', async () => {
    const urls: string[] = []
    const seen: unknown[] = []
    const { app } = deps({
      env: { OLLAMA_HOST: 'gpu-box:9000' },
      ollamaFetch: async (input) => {
        urls.push(String(input))
        return new Response('{"status":"pulling manifest"}\n{"status":"success"}\n')
      },
      during: async (appDeps) => {
        seen.push(
          await appDeps.pullModel('qwen2.5-coder:7b', {
            signal: new AbortController().signal,
            onProgress: ({ status }) => seen.push(status),
          }),
        )
      },
    })
    await runApp(app)
    expect(urls).toEqual(['http://gpu-box:9000/api/pull'])
    expect(seen).toEqual(['pulling manifest', 'success', { kind: 'pulled' }])
  })

  it('reads the index of each repository of the screens from its cache path, read-only', async () => {
    const opened: string[] = []
    const { app } = deps({
      config: 'watch:\n  repos:\n    - acme/shop\n    - acme/web\n',
      openIndexReader: async (path) => {
        opened.push(path)
        return { status: 'missing', path }
      },
      during: async (appDeps) => {
        const indexes = await appDeps.readIndexes()
        expect(indexes.repositories.map(({ repo, index }) => [repo, index.state])).toEqual([
          ['acme/shop', 'missing'],
          ['acme/web', 'missing'],
        ])
      },
    })
    app.env.PHADA_CACHE_HOME = '/cache'
    await runApp(app)
    expect(opened.sort()).toEqual(['/cache/index/acme/shop.sqlite', '/cache/index/acme/web.sqlite'])
  })

  it('opens a missing index without creating it', async () => {
    const { app } = deps({
      config: 'watch:\n  repos:\n    - acme/shop\n',
      during: async (appDeps) => {
        const [shop] = (await appDeps.readIndexes()).repositories
        expect(shop?.index.state).toBe('missing')
      },
    })
    app.env.PHADA_CACHE_HOME = indexDir
    await runApp(app)
    expect(existsSync(join(indexDir, 'index', 'acme'))).toBe(false)
  })

  it('keeps the graph of one repository open while the app runs and closes it after', async () => {
    const opened: string[] = []
    const closed: string[] = []
    const { app } = deps({
      openIndexReader: async (path) => ({ status: 'missing', path }),
      openGraph: async (repo) => {
        opened.push(repo)
        return {
          state: 'open',
          explorer: {
            repo,
            commit: 'a'.repeat(40),
            linked: [],
            search: () => ({ definitions: [], more: 0 }),
            callers: () => ({ sites: [], more: 0, capped: false }),
            dependencies: () => ({ dependencies: [], more: 0 }),
            close: () => closed.push(repo),
          },
        }
      },
      during: async (appDeps) => {
        await appDeps.searchSymbol('acme/shop', 'total')
        await appDeps.searchSymbol('acme/ui', 'Button')
        expect(closed).toEqual(['acme/shop'])
      },
    })
    await runApp(app)
    expect(opened).toEqual(['acme/shop', 'acme/ui'])
    expect(closed).toEqual(['acme/shop', 'acme/ui'])
  })

  it('explores a repository without a local copy as not indexed, creating nothing', async () => {
    const { app } = deps({
      during: async (appDeps) => {
        expect(await appDeps.searchSymbol('acme/shop', 'total')).toEqual({
          state: 'not-indexed',
          why: { reason: 'no-index' },
        })
      },
    })
    app.env.PHADA_CACHE_HOME = indexDir
    await runApp(app)
    expect(existsSync(join(indexDir, 'index', 'acme'))).toBe(false)
    expect(existsSync(join(indexDir, 'repos'))).toBe(false)
  })

  it('reads the connections from the index and mirror of the cache, never creating a mirror', async () => {
    const indexes: string[] = []
    const { app } = deps({
      config: 'watch:\n  repos:\n    - acme/shop\n',
      files: { '/cfg/repos/acme/shop/config.yml': 'context:\n  repos:\n    - acme/ui\n' },
      openIndexReader: async (path) => {
        indexes.push(path)
        return {
          status: 'open',
          index: {
            path,
            snapshot: {
              sha: 'a'.repeat(40),
              ref: 'HEAD',
              defaultBranch: true,
              indexedAt: '2026-10-25T11:00:00.000Z',
              durationMs: 10,
            },
            summary: () => {
              throw new Error('not used')
            },
            leftOut: () => [],
            reader: () => {
              throw new Error('not used')
            },
            close: () => {},
          },
        }
      },
      during: async (appDeps) => {
        const [shop] = (await appDeps.readConnections()).repositories
        expect(shop).toEqual({
          repo: 'acme/shop',
          source: { state: 'not-indexed', why: { reason: 'no-mirror' } },
          declared: {
            status: 'read',
            configError: null,
            warnings: [],
            related: [
              { repo: 'acme/ui', link: { state: 'not-indexed', why: { reason: 'no-mirror' } } },
            ],
          },
        })
      },
    })
    app.env.PHADA_CACHE_HOME = indexDir
    await runApp(app)
    expect(indexes.sort()).toEqual([
      join(indexDir, 'index', 'acme', 'shop.sqlite'),
      join(indexDir, 'index', 'acme', 'ui.sqlite'),
    ])
    expect(existsSync(join(indexDir, 'repos'))).toBe(false)
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

type FakeGitHub = ReturnType<typeof fakeGitHub>

function fakeGitHub(options: { files?: Record<string, string>; failTree?: boolean } = {}) {
  const files = options.files ?? {}
  const calls: string[] = []
  const pull = pullRequestFixture({ baseSha: 'base0001', headSha: 'head0001' })
  const readers = {
    fetchRepository: async ({
      owner,
      repo,
      token,
    }: {
      owner: string
      repo: string
      token: string
    }) => {
      calls.push(`repository ${owner}/${repo} ${token}`)
      return { repo: `${owner}/${repo}`, private: false, defaultBranch: 'trunk', empty: false }
    },
    fetchPullRequest: async ({ number, token }: { number: number; token: string }) => {
      calls.push(`pull ${number} ${token}`)
      return { ...pull, number }
    },
    fetchRepositoryTree: async ({ sha }: { sha: string }) => {
      calls.push(`tree ${sha}`)
      if (options.failTree === true) throw new Error('Resource not accessible by integration')
      return {
        entries: Object.entries(files).map(([path, text]) => ({ path, size: text.length })),
        truncated: false,
      }
    },
    fetchRepositoryFile: async ({ path, ref }: { path: string; ref: string }) => {
      calls.push(`file ${path} ${ref}`)
      return files[path] ?? null
    },
    fetchReviewState: async () => {
      calls.push('review state')
      return reviewState()
    },
    fetchPullComments: async () => {
      calls.push('comments')
      return []
    },
    fetchCheckRuns: async () => {
      calls.push('check runs')
      return []
    },
    fetchCommitStatuses: async () => [],
    fetchCheckAnnotations: async () => [],
    fetchJobLog: async () => ({ text: '', partial: false }),
  }
  return { readers, calls }
}

describe('the rules readers', () => {
  it('read the lens and the rules of the user config without GitHub', async () => {
    const github = fakeGitHub()
    const seen: unknown[] = []
    const { app } = deps({
      config:
        'review:\n  prompt:\n    file: lens.md\n    mode: replace\nrules:\n  - rule: Use UTC.\n',
      files: { '/cfg/repos/acme/shop/rules.md': 'Money in cents.' },
      github,
      during: async (appDeps) => {
        seen.push(await appDeps.readLocalRules('acme/shop'))
      },
    })

    await runApp(app)

    expect(seen).toEqual([
      {
        lens: {
          kind: 'prompt',
          prompt: {
            file: '/cfg/lens.md',
            mode: 'replace',
            origin: 'user:config.yml',
            source: 'local',
          },
          setBy: { kind: 'global', name: 'config.yml' },
        },
        rules: [
          { key: 'user:config.yml#1', name: 'config.yml#1', text: 'Use UTC.', origin: 'global' },
          {
            key: 'user:repos/acme/shop/rules.md',
            name: 'rules.md',
            text: 'Money in cents.',
            origin: 'repository',
          },
        ],
        warnings: [],
      },
    ])
    expect(github.calls).toEqual([])
  })

  it('say there is no GitHub token instead of reading the repository or a pull request', async () => {
    const github = fakeGitHub()
    const seen: unknown[] = []
    const { app } = deps({
      github,
      during: async (appDeps) => {
        seen.push(await appDeps.readRepositoryRules('acme/shop'))
        seen.push(await appDeps.readPullRequestRules('acme/shop', 15))
      },
    })

    await runApp(app)

    expect(seen).toEqual([{ status: 'no-token' }, { status: 'no-token' }])
    expect(github.calls).toEqual([])
  })

  it('read the .phada/ folder of the default branch with the token of the gh login', async () => {
    const github = fakeGitHub({
      files: {
        '.phada/config.yml': 'rules:\n  - id: cents\n    rule: Money in cents.\n',
        'AGENTS.md': 'Agents.',
      },
    })
    let read: unknown
    const { app } = deps({
      github,
      ghToken: 'gho_login',
      during: async (appDeps) => {
        read = await appDeps.readRepositoryRules('acme/shop')
      },
    })

    await runApp(app)

    expect(read).toMatchObject({
      status: 'read',
      target: { kind: 'default-branch', ref: 'trunk' },
      lens: { kind: 'built-in' },
    })
    const report = (read as { report: { rules: { key: string }[]; docs: { path: string }[] } })
      .report
    expect(report.rules.map(({ key }) => key)).toEqual(['cents'])
    expect(report.docs.map(({ path }) => path)).toEqual(['AGENTS.md'])
    expect(github.calls).toContain('repository acme/shop gho_login')
    expect(github.calls).toContain('tree trunk')
  })

  it('read the rules a pull request loads and its prompt, fetching the pull request and the tree once', async () => {
    const github = fakeGitHub({
      files: {
        '.phada/config.yml': 'review:\n  prompt:\n    file: .phada/lens.md\n',
        '.phada/lens.md': 'Look at money.',
      },
    })
    let read: unknown
    const { app, ghCalls } = deps({
      env: { GITHUB_TOKEN: 'ghp_env' },
      github,
      during: async (appDeps) => {
        read = await appDeps.readPullRequestRules('acme/shop', 15)
      },
    })

    await runApp(app)

    expect(read).toMatchObject({
      status: 'read',
      rules: {
        status: 'read',
        target: { kind: 'pull-request', number: 15, baseSha: 'base0001' },
        lens: { kind: 'prompt', prompt: { file: '.phada/lens.md', origin: '.phada/config.yml' } },
      },
      prompt: { pullRequest: { repo: 'acme/shop', number: 15, headSha: 'head0001' } },
    })
    const prompt = (read as { prompt: { passes: { data: { name: string }[] }[] } }).prompt
    expect(prompt.passes[0]?.data.map(({ name }) => name)).toContain('PHADA_DIFF')
    expect(github.calls.filter((call) => call.startsWith('pull '))).toEqual(['pull 15 ghp_env'])
    expect(github.calls.filter((call) => call.startsWith('tree '))).toEqual(['tree base0001'])
    expect(github.calls).toContain('review state')
    expect(github.calls).toContain('check runs')
    expect(ghCalls).toEqual([])
  })

  it('fail with the error of GitHub, for the screen to show', async () => {
    const github = fakeGitHub({ failTree: true })
    let error: unknown
    const { app } = deps({
      github,
      ghToken: 'gho_login',
      during: async (appDeps) => {
        error = await appDeps.readRepositoryRules('acme/shop').catch((thrown: unknown) => thrown)
      },
    })

    await runApp(app)

    expect(error).toEqual(new Error('Resource not accessible by integration'))
  })
})
