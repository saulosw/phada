import type { RunCommandResult } from '../process/run-command.js'
import { STATUS_TIMEOUT_MS, installOf, loginOf, runStatusCommand } from './cli-status.js'
import type { CliStatusOptions } from './cli-status.js'
import type { CliLogin, CliStatus } from './types.js'

const DEFAULT_COMMAND = 'claude'
const AUTH_METHOD = /^[a-z0-9][\w.-]{0,39}$/i

export async function checkClaudeStatus(options: CliStatusOptions = {}): Promise<CliStatus> {
  const command = options.command ?? DEFAULT_COMMAND
  const run = { env: options.env ?? process.env, timeoutMs: options.timeoutMs ?? STATUS_TIMEOUT_MS }
  const [version, auth] = await Promise.all([
    runStatusCommand(command, ['--version'], run),
    runStatusCommand(command, ['auth', 'status', '--json'], run),
  ])
  return { provider: 'claude', install: installOf(version), login: loginOf(auth, readAuthStatus) }
}

function readAuthStatus(result: RunCommandResult): CliLogin {
  const status = jsonObjectIn(result.stdout.trim())
  if (status === undefined || typeof status.loggedIn !== 'boolean') {
    return { state: 'unknown', problem: result.exitCode === 0 ? 'unexpected-output' : 'failed' }
  }
  if (!status.loggedIn) return { state: 'logged-out' }
  const method = status.authMethod
  return {
    state: 'logged-in',
    method: typeof method === 'string' && AUTH_METHOD.test(method) ? method : null,
  }
}

function jsonObjectIn(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
