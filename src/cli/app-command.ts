import type { LocalFileSystem } from '../config/local-files.js'
import { loadTopLevelUserLayers } from '../config/user-config.js'
import type { AppDeps, AppResult, openApp, Scheduler } from '../tui/open-app.js'
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
  const result = await openApp(await appDeps(deps), {
    stdin,
    stdout,
    onSignal: deps.onSignal,
  })
  if (result.kind === 'failed') throw result.error
  return EXIT_CODES[result.kind]
}

async function appDeps(deps: AppCommandDeps): Promise<AppDeps> {
  const base = {
    version: deps.version,
    cwd: deps.cwd,
    home: deps.home,
    env: deps.env,
    scheduler: INTERVALS,
  }
  try {
    const [layer] = await loadTopLevelUserLayers(deps)
    const language = layer?.config.language
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
