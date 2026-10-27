import { runInteractive } from '../process/run-interactive.js'
import type { AppDeps, AppHost } from '../tui/open-app.js'

const DEFAULT_EDITOR = 'vi'

export interface TerminalHandOffDeps {
  env: NodeJS.ProcessEnv
  cwd: string
  onSignal: AppHost['onSignal']
  runInteractive?: typeof runInteractive
}

export interface TerminalHandOff {
  handOff: AppDeps['handOff']
  onSignal: AppHost['onSignal']
}

export function terminalHandOff(deps: TerminalHandOffDeps): TerminalHandOff {
  const run = deps.runInteractive ?? runInteractive
  let child: AbortController | undefined
  return {
    handOff: async (target) => {
      const { command, args } =
        target.kind === 'command' ? target : editorCommand(deps.env, target.file)
      const running = new AbortController()
      child = running
      try {
        return await run(command, args, {
          cwd: deps.cwd,
          env: deps.env,
          signal: running.signal,
        })
      } finally {
        if (child === running) child = undefined
      }
    },
    onSignal: (handler) =>
      deps.onSignal((signal) => {
        if (signal === 'SIGTERM') {
          child?.abort()
          handler(signal)
        } else if (child === undefined) {
          handler(signal)
        }
      }),
  }
}

function editorCommand(
  env: NodeJS.ProcessEnv,
  file: string,
): { command: string; args: readonly string[] } {
  const chosen = [env.VISUAL, env.EDITOR].find((value) => (value?.trim() ?? '') !== '')
  const [command = DEFAULT_EDITOR, ...args] = (chosen ?? DEFAULT_EDITOR).trim().split(/\s+/)
  return { command, args: [...args, file] }
}
