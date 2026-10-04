import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandError, CommandNotFoundError, CommandTimeoutError } from '../process/errors.js'
import { runCommand } from '../process/run-command.js'
import type { RunCommandResult } from '../process/run-command.js'
import { redactSecrets } from './redact-secrets.js'
import { ProviderError } from './types.js'

const GITHUB_TOKEN_KEYS: ReadonlySet<string> = new Set(['GITHUB_TOKEN', 'GH_TOKEN'])

export interface CliNames {
  product: string
  short: string
}

export interface RunCliOptions {
  providerId: string
  names: CliNames
  command: string
  args: readonly string[]
  stdin: string
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
}

export async function runCli(options: RunCliOptions): Promise<RunCommandResult> {
  try {
    return await runCommand(options.command, options.args, {
      stdin: options.stdin,
      cwd: options.cwd,
      env: withoutGitHubTokens(options.env),
      timeoutMs: options.timeoutMs,
    })
  } catch (error) {
    throw toProviderError(error, options)
  }
}

export async function withTempDir<T>(prefix: string, use: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  try {
    return await use(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export function snippet(text: string, maxLength: number): string {
  return redactSecrets(text).trim().slice(0, maxLength)
}

function withoutGitHubTokens(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !GITHUB_TOKEN_KEYS.has(key)))
}

function toProviderError(error: unknown, { providerId, names }: RunCliOptions): unknown {
  if (error instanceof CommandNotFoundError) {
    return new ProviderError(
      providerId,
      'not-installed',
      `${names.product} was not found (command "${error.command}").`,
      { cause: error },
    )
  }
  if (error instanceof CommandTimeoutError) {
    return new ProviderError(
      providerId,
      'timeout',
      `${names.short} did not answer within ${error.timeoutMs / 1000}s.`,
      { cause: error },
    )
  }
  if (error instanceof CommandError) {
    return new ProviderError(providerId, 'failed', error.message, { cause: error })
  }
  return error
}
