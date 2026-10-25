import type { GitHubTokenSource } from '../app/read-home.js'
import { runCommand } from '../process/run-command.js'
import type { RunCommandOptions, RunCommandResult } from '../process/run-command.js'
import { withoutGitHubTokens } from '../providers/cli-run.js'
import { MissingGitHubTokenError } from './errors.js'

export type GhTokenReader = () => Promise<string | undefined>

export interface GitHubTokenDeps {
  env: NodeJS.ProcessEnv
  ghToken: GhTokenReader
}

export type RunGh = (
  command: string,
  args: readonly string[],
  options: RunCommandOptions,
) => Promise<Pick<RunCommandResult, 'stdout' | 'stderr' | 'exitCode'>>

const GH_TIMEOUT_MS = 10_000
const HOST = ['--hostname', 'github.com']
const STATUS_TOKEN = /Token:\s*(\S+)/

export interface FoundGitHubToken {
  source: GitHubTokenSource
  token: string
}

export async function readGitHubToken(deps: GitHubTokenDeps): Promise<string | undefined> {
  return (await findGitHubToken(deps))?.token
}

export async function findGitHubToken(
  deps: GitHubTokenDeps,
): Promise<FoundGitHubToken | undefined> {
  for (const source of ['GITHUB_TOKEN', 'GH_TOKEN'] as const) {
    const token = deps.env[source]?.trim()
    if (token) return { source, token }
  }
  const token = await deps.ghToken()
  return token ? { source: 'gh', token } : undefined
}

export async function requireGitHubToken(deps: GitHubTokenDeps, need?: string): Promise<string> {
  const token = await readGitHubToken(deps)
  if (token === undefined) throw new MissingGitHubTokenError(need)
  return token
}

export function ghTokenReader(env: NodeJS.ProcessEnv, run: RunGh = runCommand): GhTokenReader {
  let token: Promise<string | undefined> | undefined
  return () => (token ??= readGhToken(withoutGitHubTokens(env), run))
}

async function readGhToken(env: NodeJS.ProcessEnv, run: RunGh): Promise<string | undefined> {
  const options = { env, timeoutMs: GH_TIMEOUT_MS }
  const token = await runGh(run, ['auth', 'token', ...HOST], options)
  if (token === undefined) return undefined
  if (token.exitCode === 0) return token.stdout.trim() || undefined
  const status = await runGh(run, ['auth', 'status', '--show-token', ...HOST], options)
  if (status === undefined) return undefined
  return STATUS_TOKEN.exec(`${status.stdout}\n${status.stderr}`)?.[1]
}

async function runGh(run: RunGh, args: readonly string[], options: RunCommandOptions) {
  try {
    return await run('gh', args, options)
  } catch {
    return undefined
  }
}
