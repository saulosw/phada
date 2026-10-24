import { errorMessage } from '../app/error-message.js'
import { CommandTimeoutError } from '../process/errors.js'
import { runCommand } from '../process/run-command.js'

const SHELL = '/bin/sh'

export interface ShellOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
}

export type ShellOutcome =
  | { status: 'ok' }
  | { status: 'exited'; exitCode: number; firstLine?: string }
  | { status: 'timeout'; timeoutMs: number }
  | { status: 'error'; message: string }

export async function runShell(
  command: string,
  stdin: string,
  options: ShellOptions,
  run: typeof runCommand = runCommand,
): Promise<ShellOutcome> {
  try {
    const result = await run(SHELL, ['-c', command], { ...options, stdin, detached: true })
    if (result.exitCode === 0) return { status: 'ok' }
    const first = result.stderr.split('\n').find((line) => line.trim() !== '')
    return {
      status: 'exited',
      exitCode: result.exitCode,
      ...(first === undefined ? {} : { firstLine: first.trim() }),
    }
  } catch (error) {
    if (error instanceof CommandTimeoutError) {
      return { status: 'timeout', timeoutMs: error.timeoutMs }
    }
    return { status: 'error', message: errorMessage(error) }
  }
}
