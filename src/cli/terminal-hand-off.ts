import { setImmediate as nextTurn } from 'node:timers/promises'
import { loginCommand } from '../app/read-provider.js'
import { runInteractive } from '../process/run-interactive.js'
import { withoutGitHubTokens } from '../providers/cli-run.js'
import type { AppDeps, AppHost, HandOffTarget } from '../tui/open-app.js'
import type { TextOutput } from './progress.js'

const DEFAULT_EDITOR = 'vi'

const LINE_START = '\r'

export interface TerminalHandOffDeps {
  env: NodeJS.ProcessEnv
  stdin: NodeJS.ReadableStream
  stdout: TextOutput
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
      const { command, args, env } = handOffCommand(deps.env, target)
      const running = new AbortController()
      child = running
      await stopReading(deps.stdin)
      try {
        return await run(command, args, { cwd: deps.cwd, env, signal: running.signal })
      } finally {
        deps.stdout.write(LINE_START)
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

async function stopReading(stdin: NodeJS.ReadableStream): Promise<void> {
  await nextTurn()
  stdin.pause()
}

interface HandOffCommand {
  command: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
}

function handOffCommand(env: NodeJS.ProcessEnv, target: HandOffTarget): HandOffCommand {
  switch (target.kind) {
    case 'command':
      return { command: target.command, args: target.args, env }
    case 'ai-login':
      return { ...loginCommand(target.provider), env: withoutGitHubTokens(env) }
    case 'editor':
      return { ...editorCommand(env, target.file), env }
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
