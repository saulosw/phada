import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { ConfigError } from '../config/errors.js'
import { HISTORY_MIGRATIONS } from '../store/history-migrations.js'
import { HistoryOutdatedError, openHistoryStore } from '../store/history-store.js'
import type { HistoryStore, RunRecord } from '../store/history-store.js'
import type { AppDeps, AppHost, AppResult } from '../tui/open-app.js'
import { runApp } from './app-command.js'
import type { AppCommandDeps } from './app-command.js'
import { UsageError } from './errors.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
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
    during?: (deps: AppDeps) => Promise<void>
    ghToken?: string
    dataHome?: string
  } = {},
) {
  const ghCalls: string[][] = []
  const userTokens: string[] = []
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
  }
  app.env.PHADA_DATA_HOME = options.dataHome ?? '/data'
  return { app, opened, files, historyPaths, ghCalls, userTokens }
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
