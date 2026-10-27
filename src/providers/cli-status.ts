import { tmpdir } from 'node:os'
import { CommandNotFoundError, CommandTimeoutError } from '../process/errors.js'
import { runCommand } from '../process/run-command.js'
import type { RunCommandResult } from '../process/run-command.js'
import { withoutGitHubTokens } from './cli-run.js'
import type { CliInstall, CliLogin, StatusProblem } from './types.js'

export const STATUS_TIMEOUT_MS = 5_000
const MAX_STATUS_OUTPUT = 100_000
const VERSION = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/

export interface CliStatusOptions {
  command?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export type StatusRun =
  | { kind: 'ran'; result: RunCommandResult }
  | { kind: 'missing' }
  | { kind: 'problem'; problem: StatusProblem }

export async function runStatusCommand(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<StatusRun> {
  try {
    const result = await runCommand(command, args, {
      cwd: tmpdir(),
      env: withoutGitHubTokens(options.env),
      timeoutMs: options.timeoutMs,
      maxOutputLength: MAX_STATUS_OUTPUT,
    })
    return { kind: 'ran', result }
  } catch (error) {
    if (error instanceof CommandNotFoundError) return { kind: 'missing' }
    if (error instanceof CommandTimeoutError) return { kind: 'problem', problem: 'timeout' }
    return { kind: 'problem', problem: 'failed' }
  }
}

export function installOf(run: StatusRun): CliInstall {
  if (run.kind === 'missing') return { state: 'missing' }
  if (run.kind === 'problem') return { state: 'unknown', problem: run.problem }
  if (run.result.exitCode !== 0) return { state: 'unknown', problem: 'failed' }
  return { state: 'installed', version: VERSION.exec(run.result.stdout)?.[0] ?? null }
}

export function loginOf(run: StatusRun, read: (result: RunCommandResult) => CliLogin): CliLogin {
  if (run.kind === 'missing') return { state: 'unknown', problem: 'not-installed' }
  if (run.kind === 'problem') return { state: 'unknown', problem: run.problem }
  return read(run.result)
}
