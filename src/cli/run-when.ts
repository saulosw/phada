import type { WhenInput } from '../app/submit-request.js'
import { runShell, shellFailure } from './run-shell.js'

export const WHEN_TIMEOUT_MS = 10_000

export interface WhenCheckerOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs?: number
}

export function whenChecker(
  options: WhenCheckerOptions,
): (command: string, input: WhenInput) => Promise<string | undefined> {
  return async (command, input) => {
    const outcome = await runShell(command, `${JSON.stringify(input)}\n`, {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs ?? WHEN_TIMEOUT_MS,
    })
    if (outcome.status === 'exited' && outcome.firstLine !== undefined) return outcome.firstLine
    return shellFailure(outcome)
  }
}
