import type { RunCommandResult } from '../process/run-command.js'
import { STATUS_TIMEOUT_MS, installOf, loginOf, runStatusCommand } from './cli-status.js'
import type { CliStatusOptions } from './cli-status.js'
import type { CliLogin, CliStatus } from './types.js'

const DEFAULT_COMMAND = 'codex'
const LOGGED_OUT = /\bnot logged in\b/i
const LOGGED_IN = /\blogged in\b/i
const METHODS: ReadonlyArray<{ pattern: RegExp; method: string }> = [
  { pattern: /\blogged in using chatgpt\b/i, method: 'chatgpt' },
  { pattern: /\blogged in using (?:an )?api key\b/i, method: 'api-key' },
]

export async function checkCodexStatus(options: CliStatusOptions = {}): Promise<CliStatus> {
  const command = options.command ?? DEFAULT_COMMAND
  const run = { env: options.env ?? process.env, timeoutMs: options.timeoutMs ?? STATUS_TIMEOUT_MS }
  const [version, login] = await Promise.all([
    runStatusCommand(command, ['--version'], run),
    runStatusCommand(command, ['login', 'status'], run),
  ])
  return { provider: 'codex', install: installOf(version), login: loginOf(login, readLoginStatus) }
}

function readLoginStatus(result: RunCommandResult): CliLogin {
  const text = `${result.stdout}\n${result.stderr}`
  if (LOGGED_OUT.test(text)) return { state: 'logged-out' }
  if (result.exitCode !== 0) return { state: 'unknown', problem: 'failed' }
  if (!LOGGED_IN.test(text)) return { state: 'unknown', problem: 'unexpected-output' }
  const known = METHODS.find(({ pattern }) => pattern.test(text))
  return { state: 'logged-in', method: known?.method ?? null }
}
