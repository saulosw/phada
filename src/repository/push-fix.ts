import { join } from 'node:path'
import { runCommand } from '../process/run-command.js'
import { FETCH_TIMEOUT_MS, firstLine, promptlessGitEnvironment } from './git-checkout.js'
import type { Run } from './git-checkout.js'
import { BranchMovedError } from './branch-moved.js'
import type { GitIdentity } from './git-identity.js'
import { gitHubAuth } from './github-auth.js'

export interface CommitWorkTreeOptions {
  dir: string
  tree: string
  message: string
  identity: GitIdentity
  env: NodeJS.ProcessEnv
  run?: Run
}

export interface PushCommitOptions {
  dir: string
  commit: string
  branch: string
  owner: string
  repo: string
  token: string
  env: NodeJS.ProcessEnv
  url?: string
  run?: Run
}

const REJECTED = /^!\t[^\t]*\t(.*)$/m
const COMMIT_TIMEOUT_MS = 120_000

export class CommitFailedError extends Error {
  override readonly name = 'CommitFailedError'
}

export class PushFailedError extends Error {
  override readonly name = 'PushFailedError'
}

export async function commitWorkTree(options: CommitWorkTreeOptions): Promise<string> {
  const run = options.run ?? runCommand
  const env = promptlessGitEnvironment(options.env)
  const { name, email, signing } = options.identity
  const git = async (args: readonly string[], stdin?: string) => {
    const result = await run('git', ['-C', options.dir, ...args], {
      env,
      timeoutMs: COMMIT_TIMEOUT_MS,
      ...(stdin === undefined ? {} : { stdin }),
    })
    if (result.exitCode !== 0) {
      throw new CommitFailedError(
        `Could not commit the fix: ${firstLine(result.stderr) || `git ${args[0]} exited with code ${result.exitCode}`}`,
      )
    }
    return result.stdout.trim()
  }
  await git(['read-tree', options.tree])
  await git(
    [
      ...configFlags([
        ['user.name', name],
        ['user.email', email],
        ...signing,
        ['core.hooksPath', join(options.dir, '.git', 'no-hooks')],
      ]),
      'commit',
      '-q',
      '--no-verify',
      '--cleanup=verbatim',
      '-F',
      '-',
    ],
    options.message,
  )
  return git(['rev-parse', '--verify', 'HEAD^{commit}'])
}

export async function pushCommit(options: PushCommitOptions): Promise<void> {
  const run = options.run ?? runCommand
  const { owner, repo, branch } = options
  const auth = gitHubAuth(options.token)
  const result = await run(
    'git',
    [
      '-C',
      options.dir,
      'push',
      '--porcelain',
      '--no-verify',
      '--no-signed',
      '--recurse-submodules=no',
      options.url ?? `https://github.com/${owner}/${repo}.git`,
      `${options.commit}:refs/heads/${branch}`,
    ],
    { env: { ...promptlessGitEnvironment(options.env), ...auth.env }, timeoutMs: FETCH_TIMEOUT_MS },
  )
  if (result.exitCode === 0) return
  const status = REJECTED.exec(result.stdout)?.[1] ?? ''
  if (status.startsWith('[rejected]')) throw new BranchMovedError(`${owner}/${repo}`, branch)
  const detail = auth
    .scrub(status || firstLine(result.stderr))
    .replace(/\s+/g, ' ')
    .trim()
  throw new PushFailedError(
    `Could not push to ${owner}/${repo}:${branch}: ${detail || `git exited with code ${result.exitCode}`}`,
  )
}

function configFlags(pairs: readonly (readonly [string, string])[]): string[] {
  return pairs.flatMap(([key, value]) => ['-c', `${key}=${value}`])
}
