import { toTerminalText } from '../app/terminal-text.js'
import { dataFiles } from '../config/data-paths.js'
import { loadTopLevelUserLayers, userConfigFile } from '../config/user-config.js'
import type { StopSignal } from '../tui/open-app.js'
import type { IndexFormat } from './args.js'
import { formatError } from './format-error.js'
import { formatWatchEvent } from './format-watch.js'
import { printReviewProgress } from './print-review-progress.js'
import type { TextOutput } from './progress.js'
import { startWatch } from './watch-session.js'
import type { WatchHandle, WatchSessionDeps } from './watch-session.js'
import { watchStatusText } from './watch-status.js'

export const ABORTED_EXIT_CODE = 130

export interface WatchCommandDeps extends WatchSessionDeps {
  stdout: TextOutput
  stderr: TextOutput
  onSignal: (handler: (signal?: StopSignal) => void) => void
  abort: (code: number) => void
}

export interface WatchCommand {
  once: boolean
  backfill: boolean
  status: boolean
  format: IndexFormat
  debug: boolean
}

export async function runWatch(command: WatchCommand, deps: WatchCommandDeps): Promise<number> {
  if (command.status) return printStatus(command, deps)
  const write = (text: string) => deps.stderr.write(text)
  const handle = await startWatch({ once: command.once, backfill: command.backfill }, deps, {
    event: (event) => write(`${formatWatchEvent(event, deps.clock())}\n`),
    warning: (message) => write(`Warning: ${toTerminalText(message)}\n`),
    progress: () => ({
      review: printReviewProgress(deps.stderr),
      reviewAndPublish: () => undefined,
    }),
  })
  deps.onSignal(() => interrupt(handle, write))
  const end = await handle.done
  if (end.reason === 'aborted') {
    write('Aborted.\n')
    deps.abort(ABORTED_EXIT_CODE)
    return ABORTED_EXIT_CODE
  }
  if (end.reason === 'fatal') {
    write(`${formatError(end.error, { debug: command.debug }).message}\n`)
    return 1
  }
  if (end.reason === 'stopped') write('Stopped.\n')
  return 0
}

function interrupt(handle: WatchHandle, write: (text: string) => void): void {
  if (handle.stopRequested()) {
    handle.abort()
    return
  }
  write(
    handle.running() === undefined
      ? 'Stopping…\n'
      : 'Stopping after the current review (Ctrl-C again to abort).\n',
  )
  handle.stop()
}

async function printStatus(command: WatchCommand, deps: WatchCommandDeps): Promise<number> {
  const layers = await loadTopLevelUserLayers(deps)
  const files = dataFiles(deps.env, deps.home)
  const history = await deps.openHistoryStore(files.history)
  try {
    const holder = await deps.lockHolder(files.lock)
    deps.stdout.write(
      watchStatusText(
        history,
        layers,
        holder,
        deps.clock(),
        command.format,
        userConfigFile(deps.env, deps.home),
      ),
    )
  } finally {
    history.close()
  }
  return 0
}
