import { join } from 'node:path'
import type { ProviderCheckers } from '../app/check-providers.js'
import { readReviewDetail, readReviews } from '../app/read-history.js'
import { readLearnings } from '../app/read-learnings.js'
import type { ObservedRead } from '../app/read-learnings.js'
import { providerSetup, readProviders } from '../app/read-provider.js'
import type { ProviderConfigInput } from '../app/read-provider.js'
import { readQueue } from '../app/read-queue.js'
import { readAutomation } from '../app/read-automation.js'
import type { AutomationReaders } from '../app/read-automation.js'
import { readRepositories, readRepository } from '../app/read-repositories.js'
import type { RepositoryReaders } from '../app/read-repositories.js'
import { observedRepositories, phadaCacheDir, repositoryCache } from '../config/cache-paths.js'
import { dataFiles } from '../config/data-paths.js'
import type { LocalFileSystem } from '../config/local-files.js'
import {
  listUserRepoConfigs,
  loadTopLevelUserLayers,
  loadUserLayers,
  userConfigDir,
} from '../config/user-config.js'
import { resolveWatchSettings } from '../config/watch-settings.js'
import type { WatchSettings } from '../config/watch-settings.js'
import { checkClaudeStatus } from '../providers/claude-status.js'
import { checkCodexStatus } from '../providers/codex-status.js'
import { checkOllamaStatus } from '../providers/ollama-status.js'
import { openExistingHistoryStore } from '../store/history-store.js'
import type { HistoryStore } from '../store/history-store.js'
import { readObservedEdges } from '../store/observed-store.js'
import type { AppDeps, AppResult, openApp, Scheduler } from '../tui/open-app.js'
import { appHistory } from './app-history.js'
import type { AppHistory } from './app-history.js'
import { UsageError } from './errors.js'
import type { TextOutput } from './progress.js'
import { SLACK_APP_TOKEN, SLACK_BOT_TOKEN } from './review-event-sinks.js'

export type StopSignal = 'SIGINT' | 'SIGTERM'

export interface AppCommandDeps {
  env: NodeJS.ProcessEnv
  home: string
  cwd: string
  version: string
  files: LocalFileSystem
  stdin: NodeJS.ReadableStream
  stdout: TextOutput
  onSignal: (handler: (signal?: StopSignal) => void) => void
  loadApp?: () => Promise<{ openApp: typeof openApp }>
  clock: () => Date
  lockHolder: (path: string) => Promise<number | undefined>
  openHistoryStore: (path: string) => Promise<HistoryStore>
  pathSize: (path: string) => Promise<number>
  providerCheckers?: ProviderCheckers
  observed?: {
    list(cacheDir: string): Promise<string[]>
    read: typeof readObservedEdges
  }
}

const EXIT_CODES: Readonly<Record<Exclude<AppResult['kind'], 'failed'>, number>> = {
  quit: 0,
  interrupted: 130,
  terminated: 143,
}

const INTERVALS: Scheduler = {
  every: (ms, tick) => {
    const timer = setInterval(tick, ms)
    return () => clearInterval(timer)
  },
}

export async function runApp(deps: AppCommandDeps): Promise<number> {
  const { stdin, stdout } = deps
  if (!isTerminalInput(stdin) || !isTerminalOutput(stdout)) {
    throw new UsageError('Missing the command, e.g. phada review owner/repo#123.')
  }
  const { openApp } = await (deps.loadApp ?? (() => import('../tui/open-app.js')))()
  const files = dataFiles(deps.env, deps.home)
  const history = appHistory(files.history, (path) =>
    openExistingHistoryStore(path, {
      exists: (file) => deps.files.exists(file),
      open: deps.openHistoryStore,
    }),
  )
  try {
    const result = await openApp(await appDeps(deps, history, files.lock), {
      stdin,
      stdout,
      onSignal: deps.onSignal,
    })
    if (result.kind === 'failed') throw result.error
    return EXIT_CODES[result.kind]
  } finally {
    history.close()
  }
}

async function appDeps(deps: AppCommandDeps, history: AppHistory, lock: string): Promise<AppDeps> {
  let settings: WatchSettings | undefined
  const base = {
    version: deps.version,
    cwd: deps.cwd,
    home: deps.home,
    env: deps.env,
    scheduler: INTERVALS,
    now: deps.clock,
    readQueue: async () =>
      readQueue({
        history: await history.current(),
        settings,
        holder: await deps.lockHolder(lock),
        now: deps.clock(),
      }),
    readReviews: async (filter: Parameters<AppDeps['readReviews']>[0]) =>
      readReviews(await history.current(), filter),
    readReviewDetail: async (id: number) => readReviewDetail(await history.current(), id),
    readRepositories: () => readRepositories(repositoryReaders(deps, history)),
    readRepository: (repo: string) => readRepository(repositoryReaders(deps, history), repo),
    readAutomation: () => readAutomation(automationReaders(deps)),
    readProviderSetup: async () => providerSetup(await providerConfig(deps)),
    readProviders: async () =>
      readProviders({
        ...(await providerConfig(deps)),
        checkers: deps.providerCheckers ?? statusCheckers(deps.env),
      }),
    readLearnings: async () =>
      readLearnings({
        history: await history.current(),
        observedRepos: () =>
          (deps.observed?.list ?? observedRepositories)(phadaCacheDir(deps.env, deps.home)),
        readObserved: (repo) => observedOf(deps, repo),
      }),
  }
  try {
    const layers = await loadTopLevelUserLayers(deps)
    settings = resolveWatchSettings(layers)
    const language = layers[0]?.config.language
    return language === undefined ? base : { ...base, language }
  } catch (configError) {
    return { ...base, configError }
  }
}

function repositoryReaders(deps: AppCommandDeps, history: AppHistory): RepositoryReaders {
  const { env, home, files } = deps
  return {
    configFile: join(userConfigDir(env, home), 'config.yml'),
    topLevelLayers: () => loadTopLevelUserLayers(deps),
    userLayers: (repo) => {
      const [owner = '', name = ''] = repo.split('/')
      return loadUserLayers({ env, home, files, owner, repo: name })
    },
    userRepoConfigs: () => listUserRepoConfigs(deps),
    history: () => history.current(),
    indexFile: async (repo) => {
      const [owner = '', name = ''] = repo.split('/')
      const path = repositoryCache(env, home, owner, name).index
      return (await files.exists(path)) ? { path, bytes: await deps.pathSize(path) } : null
    },
  }
}

function automationReaders(deps: AppCommandDeps): AutomationReaders {
  const present = (name: string) => (deps.env[name]?.trim() ?? '') !== ''
  return {
    configFile: join(userConfigDir(deps.env, deps.home), 'config.yml'),
    topLevelLayers: () => loadTopLevelUserLayers(deps),
    slackTokens: () => ({ bot: present(SLACK_BOT_TOKEN), app: present(SLACK_APP_TOKEN) }),
  }
}

async function providerConfig(deps: AppCommandDeps): Promise<ProviderConfigInput> {
  return {
    layers: await loadTopLevelUserLayers(deps),
    configPath: join(userConfigDir(deps.env, deps.home), 'config.yml'),
  }
}

function statusCheckers(env: NodeJS.ProcessEnv): ProviderCheckers {
  return {
    claude: () => checkClaudeStatus({ env }),
    codex: () => checkCodexStatus({ env }),
    ollama: () => checkOllamaStatus({ env }),
  }
}

async function observedOf(deps: AppCommandDeps, repo: string): Promise<ObservedRead> {
  const [owner = '', name = ''] = repo.split('/')
  const read = await (deps.observed?.read ?? readObservedEdges)(
    repositoryCache(deps.env, deps.home, owner, name).observed,
  )
  if (read === 'unreadable') return { state: 'unreadable' }
  return { state: 'read', edges: read === 'missing' ? [] : read }
}

function isTerminalInput(stream: NodeJS.ReadableStream): stream is NodeJS.ReadStream {
  return 'isTTY' in stream && stream.isTTY === true
}

function isTerminalOutput(stream: TextOutput): stream is TextOutput & NodeJS.WriteStream {
  return stream.isTTY === true
}
