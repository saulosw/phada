import { readReviewDetail, readReviews } from '../app/read-history.js'
import { readQueue } from '../app/read-queue.js'
import { dataFiles } from '../config/data-paths.js'
import type { LocalFileSystem } from '../config/local-files.js'
import { loadTopLevelUserLayers } from '../config/user-config.js'
import { resolveWatchSettings } from '../config/watch-settings.js'
import type { WatchSettings } from '../config/watch-settings.js'
import { openExistingHistoryStore } from '../store/history-store.js'
import type { HistoryStore } from '../store/history-store.js'
import type { AppDeps, AppResult, openApp, Scheduler } from '../tui/open-app.js'
import { appHistory } from './app-history.js'
import type { AppHistory } from './app-history.js'
import { UsageError } from './errors.js'
import type { TextOutput } from './progress.js'

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

function isTerminalInput(stream: NodeJS.ReadableStream): stream is NodeJS.ReadStream {
  return 'isTTY' in stream && stream.isTTY === true
}

function isTerminalOutput(stream: TextOutput): stream is TextOutput & NodeJS.WriteStream {
  return stream.isTTY === true
}
