import { execa } from 'execa'
import {
  CommandError,
  CommandNotFoundError,
  CommandOutputTooLargeError,
  CommandTimeoutError,
} from './errors.js'

const DEFAULT_TIMEOUT_MS = 600_000
const DEFAULT_MAX_OUTPUT_LENGTH = 10_000_000

export interface RunCommandOptions {
  stdin?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxOutputLength?: number
}

export interface RunCommandResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputLength = options.maxOutputLength ?? DEFAULT_MAX_OUTPUT_LENGTH
  const startedAt = performance.now()
  const result = await execa(command, args, {
    input: options.stdin ?? '',
    cwd: options.cwd,
    env: options.env ?? {},
    extendEnv: false,
    timeout: timeoutMs,
    maxBuffer: maxOutputLength,
    reject: false,
    stripFinalNewline: false,
  })
  const durationMs = performance.now() - startedAt

  if (result.code === 'ENOENT') throw new CommandNotFoundError(command)
  if (result.timedOut) throw new CommandTimeoutError(command, timeoutMs)
  if (result.isMaxBuffer) throw new CommandOutputTooLargeError(command, maxOutputLength)
  if (result.exitCode === undefined) {
    const cause = result.signal ?? result.code ?? 'an unknown reason'
    throw new CommandError(command, `Command "${command}" ended without an exit code (${cause}).`)
  }
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, durationMs }
}
