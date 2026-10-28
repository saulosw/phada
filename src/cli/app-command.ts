import type { ProviderCheckers } from '../app/check-providers.js'
import type { IndexingOptions } from '../app/index-repository.js'
import { applyUserConfigPlan, planUserConfig } from '../app/edit-user-config.js'
import { indexedCommit, openGraphExplorer } from '../app/explore-graph.js'
import type { ExplorerReaders } from '../app/explore-graph.js'
import { readReviewDetail, readReviews } from '../app/read-history.js'
import { readConnections } from '../app/read-connections.js'
import type { ConnectionReaders } from '../app/read-connections.js'
import { readIndexes } from '../app/read-index.js'
import type { IndexReaders } from '../app/read-index.js'
import { readLearnings } from '../app/read-learnings.js'
import type { ObservedRead } from '../app/read-learnings.js'
import { providerSetup, readProviderChecks, readProviders } from '../app/read-provider.js'
import type { ModelPullOptions, ProviderConfigInput } from '../app/read-provider.js'
import { readQueue } from '../app/read-queue.js'
import { readAutomation } from '../app/read-automation.js'
import type { AutomationReaders } from '../app/read-automation.js'
import { readRepositories, readRepository } from '../app/read-repositories.js'
import { readUserRepositories } from '../app/read-user-repositories.js'
import { readRepositoryFolder } from '../app/repository-folder.js'
import type { RepositoryReaders } from '../app/read-repositories.js'
import { observedRepositories, phadaCacheDir, repositoryCache } from '../config/cache-paths.js'
import { dataFiles } from '../config/data-paths.js'
import type { LocalFileSystem } from '../config/local-files.js'
import {
  listUserRepoConfigs,
  loadTopLevelUserLayers,
  loadUserLayers,
  userConfigFile,
} from '../config/user-config.js'
import type { UserRepoFile } from '../config/user-config.js'
import type { UserConfigChange, UserConfigPlan } from '../config/user-config-edit.js'
import { resolveWatchSettings } from '../config/watch-settings.js'
import type { WatchSettings } from '../config/watch-settings.js'
import { checkClaudeStatus } from '../providers/claude-status.js'
import { openExistingGitMirror } from '../repository/git-mirror.js'
import { checkCodexStatus } from '../providers/codex-status.js'
import { pullOllamaModel } from '../providers/ollama-pull.js'
import { checkOllamaStatus } from '../providers/ollama-status.js'
import type { runInteractive } from '../process/run-interactive.js'
import { openExistingHistoryStore, openHistoryStore } from '../store/history-store.js'
import type { HistoryStore } from '../store/history-store.js'
import { openExistingIndexStore } from '../store/index-store.js'
import type { IndexOpening } from '../store/index-store.js'
import { readObservedEdges } from '../store/observed-store.js'
import { splitRepoName } from '../github/pull-request-ref.js'
import { fetchAuthenticatedUser } from '../github/user.js'
import { listUserRepositories } from '../github/user-repositories.js'
import type { UserRepository } from '../github/user-repositories.js'
import type { FetchUserOptions, GitHubUser } from '../github/user.js'
import type { AppDeps, AppResult, AppStart, openApp, Scheduler } from '../tui/open-app.js'
import type { ColorEnv } from '../tui/theme.js'
import { appGraph } from './app-graph.js'
import type { AppGraph } from './app-graph.js'
import { appHistory } from './app-history.js'
import { rulesReaders } from './app-rules.js'
import type { RulesReaderDeps } from './app-rules.js'
import type { AppHistory } from './app-history.js'
import { UsageError } from './errors.js'
import { readGitHubAccess } from './github-access.js'
import { USER_CONFIG_TEMPLATE } from './init-templates.js'
import { ghTokenReader, readGitHubToken } from './github-token.js'
import type { GhTokenReader, RunGh } from './github-token.js'
import type { TextOutput } from './progress.js'
import { indexForApp } from './app-index.js'
import { appReview } from './app-review.js'
import type { AppReviewDeps } from './app-review.js'
import { initRepository } from './init.js'
import type { AppIndexDeps } from './app-index.js'
import { SLACK_APP_TOKEN, SLACK_BOT_TOKEN } from './review-event-sinks.js'
import { terminalHandOff } from './terminal-hand-off.js'
import { ensureUserRepoFile } from './user-repo-file.js'
import type { TerminalHandOff } from './terminal-hand-off.js'

export type StopSignal = 'SIGINT' | 'SIGTERM'

export interface AppCommandDeps
  extends
    Omit<RulesReaderDeps, 'ghToken'>,
    Omit<AppIndexDeps, 'ghToken'>,
    Omit<AppReviewDeps, 'ghToken'> {
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
  openHistoryReader?: (path: string) => Promise<HistoryStore>
  openIndexReader?: (path: string) => Promise<IndexOpening>
  openGraph?: typeof openGraphExplorer
  pathSize: (path: string) => Promise<number>
  providerCheckers?: ProviderCheckers
  observed?: {
    list(cacheDir: string): Promise<string[]>
    read: typeof readObservedEdges
  }
  runGh?: RunGh
  fetchUser?: (options: FetchUserOptions) => Promise<GitHubUser>
  listRepositories?: (options: FetchUserOptions) => Promise<UserRepository[]>
  runInteractive?: typeof runInteractive
  ollamaFetch?: typeof globalThis.fetch
}

const EXIT_CODES: Readonly<Record<Exclude<AppResult['kind'], 'failed'>, number>> = {
  quit: 0,
  interrupted: 130,
  terminated: 143,
}

const MISSING_COMMAND = 'Missing the command, e.g. phada review owner/repo#123.'

const SETUP_NEEDS_TERMINAL = 'phada setup needs an interactive terminal.'

const COLOR_VARIABLES = ['NO_COLOR', 'FORCE_COLOR', 'TERM', 'COLORTERM'] as const

const INTERVALS: Scheduler = {
  every: (ms, tick) => {
    const timer = setInterval(tick, ms)
    return () => clearInterval(timer)
  },
}

export function assertAppTerminal(
  command: { debug: boolean },
  { stdin, stdout }: Pick<AppCommandDeps, 'stdin' | 'stdout'>,
): void {
  if (isTerminalInput(stdin) && isTerminalOutput(stdout)) return
  throw new UsageError(command.debug ? "Unknown option '--debug'." : MISSING_COMMAND)
}

export async function runApp(
  deps: AppCommandDeps,
  options: { setup: boolean } = { setup: false },
): Promise<number> {
  const { stdin, stdout } = deps
  if (!isTerminalInput(stdin) || !isTerminalOutput(stdout)) {
    throw new UsageError(options.setup ? SETUP_NEEDS_TERMINAL : MISSING_COMMAND)
  }
  const start: AppStart =
    options.setup || !(await deps.files.exists(userConfigFile(deps.env, deps.home)))
      ? 'setup'
      : 'home'
  const { openApp } = await (deps.loadApp ?? (() => import('../tui/open-app.js')))()
  const files = dataFiles(deps.env, deps.home)
  const history = appHistory(files.history, (path) =>
    openExistingHistoryStore(path, {
      exists: (file) => deps.files.exists(file),
      open: deps.openHistoryReader ?? ((path) => openHistoryStore(path, { readOnly: true })),
    }),
  )
  const graph = graphOf(deps, history)
  const terminal = terminalHandOff(deps)
  try {
    const result = await openApp(await appDeps(deps, history, graph, files.lock, terminal, start), {
      stdin,
      stdout,
      onSignal: terminal.onSignal,
    })
    if (result.kind === 'failed') throw result.error
    return EXIT_CODES[result.kind]
  } finally {
    history.close()
    graph.close()
  }
}

async function appDeps(
  deps: AppCommandDeps,
  history: AppHistory,
  graph: AppGraph,
  lock: string,
  terminal: TerminalHandOff,
  start: AppStart,
): Promise<AppDeps> {
  let settings: WatchSettings | undefined
  const watchSettings = () =>
    loadTopLevelUserLayers(deps).then(
      (layers) => (settings = resolveWatchSettings(layers)),
      () => settings,
    )
  const readLanguage = async () => (await loadTopLevelUserLayers(deps))[0]?.config.language
  const ghToken: GhTokenReader = () => ghTokenReader(deps.env, deps.runGh)()
  const review = appReview({ ...deps, ghToken })
  const base = {
    version: deps.version,
    start,
    cwd: deps.cwd,
    home: deps.home,
    env: colorEnv(deps.env),
    scheduler: INTERVALS,
    now: deps.clock,
    readLanguage,
    readQueue: async () =>
      readQueue({
        history: await history.current(),
        settings: await watchSettings(),
        holder: await deps.lockHolder(lock),
        now: deps.clock(),
        configFile: userConfigFile(deps.env, deps.home),
      }),
    readReviews: async (filter: Parameters<AppDeps['readReviews']>[0]) =>
      readReviews(await history.current(), filter),
    readReviewDetail: async (id: number) => readReviewDetail(await history.current(), id),
    readRepositories: () => readRepositories(repositoryReaders(deps, history)),
    readRepository: (repo: string) => readRepository(repositoryReaders(deps, history), repo),
    readAutomation: () => readAutomation(automationReaders(deps)),
    readIndexes: () => readIndexes(indexReaders(deps, history)),
    readConnections: () => readConnections(connectionReaders(deps, history)),
    searchSymbol: graph.searchSymbol,
    symbolCallers: graph.symbolCallers,
    symbolDependencies: graph.symbolDependencies,
    readProviderSetup: async () => providerSetup(await providerConfig(deps)),
    readProviders: async () =>
      readProviders({
        ...(await providerConfig(deps)),
        checkers: deps.providerCheckers ?? statusCheckers(deps.env),
      }),
    readProviderChecks: () => readProviderChecks(deps.providerCheckers ?? statusCheckers(deps.env)),
    readLearnings: async () =>
      readLearnings({
        history: await history.current(),
        observedRepos: () =>
          (deps.observed?.list ?? observedRepositories)(phadaCacheDir(deps.env, deps.home)),
        readObserved: (repo) => observedOf(deps, repo),
      }),
    readGitHub: () =>
      readGitHubAccess({
        env: deps.env,
        ghToken,
        fetchUser: deps.fetchUser ?? fetchAuthenticatedUser,
      }),
    readUserRepositories: () =>
      readUserRepositories({
        token: () => readGitHubToken({ env: deps.env, ghToken }),
        listRepositories: (token) => (deps.listRepositories ?? listUserRepositories)({ token }),
        watchedRepos: async () =>
          resolveWatchSettings(await loadTopLevelUserLayers(deps))?.repos.map(({ repo }) => repo) ??
          [],
      }),
    ...rulesReaders({ ...deps, ghToken }),
    handOff: terminal.handOff,
    pullModel: (model: string, options: ModelPullOptions) =>
      pullOllamaModel(model, {
        env: deps.env,
        ...options,
        ...(deps.ollamaFetch === undefined ? {} : { fetch: deps.ollamaFetch }),
      }),
    planConfig: (changes: readonly UserConfigChange[]) =>
      planUserConfig(
        { env: deps.env, home: deps.home, template: USER_CONFIG_TEMPLATE, changes },
        deps.files,
      ),
    applyConfig: (plan: UserConfigPlan) => applyUserConfigPlan(plan, deps.files),
    indexRepository: (repo: string, options: IndexingOptions) =>
      indexForApp(repo, options, { ...deps, ghToken }),
    parsePullRequest: review.parsePullRequest,
    readOpenPullRequests: review.readOpenPullRequests,
    reviewPullRequest: review.reviewPullRequest,
    enqueueReview: review.enqueueReview,
    readRepositoryFolder: () => readRepositoryFolder(deps.cwd, (path) => deps.files.exists(path)),
    initRepository: () => initRepository(deps),
    ensureRepositoryFile: (repo: string, file: UserRepoFile) =>
      ensureUserRepoFile(repo, file, deps),
  }
  const language = await readLanguage().catch(() => undefined)
  return language === undefined ? base : { ...base, language }
}

function colorEnv(env: NodeJS.ProcessEnv): ColorEnv {
  return Object.fromEntries(
    COLOR_VARIABLES.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])),
  )
}

function repositoryReaders(deps: AppCommandDeps, history: AppHistory): RepositoryReaders {
  const { env, home, files } = deps
  return {
    configFile: userConfigFile(env, home),
    topLevelLayers: () => loadTopLevelUserLayers(deps),
    userLayers: (repo) => loadUserLayers({ env, home, files, ...splitRepoName(repo) }),
    userRepoConfigs: () => listUserRepoConfigs(deps),
    history: () => history.current(),
    indexFile: async (repo) => {
      const { owner, repo: name } = splitRepoName(repo)
      const path = repositoryCache(env, home, owner, name).index
      return (await files.exists(path)) ? { path, bytes: await deps.pathSize(path) } : null
    },
  }
}

function indexReaders(deps: AppCommandDeps, history: AppHistory): IndexReaders {
  const { env, home } = deps
  return {
    repositories: async () =>
      (await readRepositories(repositoryReaders(deps, history))).repositories.map(
        ({ repo }) => repo,
      ),
    indexPath: (repo) => {
      const { owner, repo: name } = splitRepoName(repo)
      return repositoryCache(env, home, owner, name).index
    },
    openIndex:
      deps.openIndexReader ??
      ((path) =>
        openExistingIndexStore(path, {
          version: deps.version,
          exists: (file) => deps.files.exists(file),
        })),
    fileSize: deps.pathSize,
  }
}

function connectionReaders(deps: AppCommandDeps, history: AppHistory): ConnectionReaders {
  const { env, home, files } = deps
  const indexes = indexReaders(deps, history)
  return {
    repositories: indexes.repositories,
    userLayers: (repo) => loadUserLayers({ env, home, files, ...splitRepoName(repo) }),
    openIndex: (repo) => indexes.openIndex(indexes.indexPath(repo)),
    openMirror: (repo) => {
      const { owner, repo: name } = splitRepoName(repo)
      return openExistingGitMirror({ dir: repositoryCache(env, home, owner, name).mirror, env })
    },
  }
}

function graphOf(deps: AppCommandDeps, history: AppHistory): AppGraph {
  const readers: ExplorerReaders = {
    ...connectionReaders(deps, history),
    readObserved: async (repo) => {
      const read = await observedOf(deps, repo)
      return read.state === 'read' ? read.edges : []
    },
  }
  return appGraph({
    open: (repo) => (deps.openGraph ?? openGraphExplorer)(repo, readers),
    commitOf: (repo) => indexedCommit(repo, readers),
  })
}

function automationReaders(deps: AppCommandDeps): AutomationReaders {
  const token = (variable: string) => ({
    variable,
    set: (deps.env[variable]?.trim() ?? '') !== '',
  })
  return {
    configFile: userConfigFile(deps.env, deps.home),
    topLevelLayers: () => loadTopLevelUserLayers(deps),
    slackTokens: () => ({ bot: token(SLACK_BOT_TOKEN), app: token(SLACK_APP_TOKEN) }),
  }
}

async function providerConfig(deps: AppCommandDeps): Promise<ProviderConfigInput> {
  return {
    layers: await loadTopLevelUserLayers(deps),
    configPath: userConfigFile(deps.env, deps.home),
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
  const { owner, repo: name } = splitRepoName(repo)
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
