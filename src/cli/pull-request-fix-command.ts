import { fixPullRequest, pushPullRequestFix, readPullRequestFix } from '../app/pull-request-fix.js'
import type { PullRequestFix, PullRequestFixTarget } from '../app/pull-request-fix.js'
import { toTerminalText } from '../app/terminal-text.js'
import { repositoryCache } from '../config/cache-paths.js'
import { nodeFileSystem } from '../config/local-files.js'
import { formatPullRequestRef } from '../github/pull-request-ref.js'
import type { PullRequestRef } from '../github/pull-request-ref.js'
import type {
  FetchReviewStateOptions,
  PullRequestReviewState,
} from '../github/pull-request-reviews.js'
import type { FetchPullRequestOptions, PullRequestMetadata } from '../github/pull-request.js'
import type { RepositoryInfo } from '../github/repository.js'
import type { RepositoryFilesOptions } from '../github/repository-files.js'
import type { GitMirror, GitMirrorOptions } from '../repository/git-mirror.js'
import { readGitIdentity } from '../repository/git-identity.js'
import type { GitIdentity } from '../repository/git-identity.js'
import { openLocalGit } from '../repository/local-git.js'
import { commitWorkTree, pushCommit } from '../repository/push-fix.js'
import type { PushCommitOptions } from '../repository/push-fix.js'
import type { StopSignal } from '../tui/open-app.js'
import { confirm, isTerminalInput } from './confirm.js'
import { UsageError } from './errors.js'
import type { FixCommand, FixCommandDeps } from './fix-command.js'
import { fixProvider, pickNumbers, workingFiles } from './fix-wiring.js'
import { formatFixReport, formatFixWarnings, listed } from './format-fix.js'
import { requireGitHubToken } from './github-token.js'
import type { GitHubTokenDeps } from './github-token.js'

export interface PullRequestFixCommandDeps extends FixCommandDeps, GitHubTokenDeps {
  stdin: NodeJS.ReadableStream
  onSignal: (handler: (signal?: StopSignal) => void) => void
  abort: (code: number) => void
  fetchPullRequestMetadata: (options: FetchPullRequestOptions) => Promise<PullRequestMetadata>
  fetchRepository: (options: RepositoryFilesOptions) => Promise<RepositoryInfo>
  fetchReviewState: (options: FetchReviewStateOptions) => Promise<PullRequestReviewState>
  openMirror: (options: GitMirrorOptions) => Promise<GitMirror>
  pushCommit?: (options: PushCommitOptions) => Promise<void>
}

export async function runPullRequestFix(
  command: FixCommand & { ref: PullRequestRef; yes: boolean },
  deps: PullRequestFixCommandDeps,
): Promise<void> {
  const { ref } = command
  const name = formatPullRequestRef(ref)
  if (!command.list && !command.yes && !isTerminalInput(deps.stdin)) {
    throw new UsageError(
      'phada fix asks before it commits and pushes, and stdin is not a terminal: pass --yes to commit and push without asking.',
    )
  }
  const token = await requireGitHubToken(deps)
  const repository = { owner: ref.owner, repo: ref.repo, token }
  const target = await readPullRequestFix({
    fetchPullRequest: () => deps.fetchPullRequestMetadata({ ...ref, token }),
    fetchRepository: () => deps.fetchRepository(repository),
    fetchReviewState: () => deps.fetchReviewState({ ...ref, token }),
  })
  if (target.findings.length === 0) {
    deps.stdout.write(`Nothing to fix: ${name} has no open Phada comment.\n`)
    return
  }
  const picked = pickNumbers(
    target.findings,
    command.only,
    (number, last) => `No comment ${number} on ${name}: its comments go from 1 to ${last}.`,
  )
  const heading = `Open Phada comments on ${name} (${branchOf(target)}):`
  if (command.list) {
    deps.stdout.write(listed(heading, target.findings))
    return
  }
  const identity = await readGitIdentity({ dir: deps.cwd, env: deps.env })
  const provider = await fixProvider(ref, command, deps)
  deps.stdout.write(listed(heading, target.findings))
  deps.onSignal(() => deps.abort(130))
  const { mirror } = repositoryCache(deps.env, deps.home, ref.owner, ref.repo)
  const fixed = await fixPullRequest(target, picked, {
    openMirror: () => deps.openMirror({ dir: mirror, ...repository, env: deps.env }),
    openTree: (dir) => (deps.openLocalGit ?? openLocalGit)({ dir, env: deps.env }),
    files: (root) => workingFiles(root, deps.workingTreeFiles ?? nodeFileSystem),
    env: deps.env,
    warning: (message) => deps.stderr.write(`Warning: ${toTerminalText(message)}\n`),
    provider,
  })
  try {
    await accept(fixed, { name, branch: branchOf(target), target, token, identity }, command, deps)
  } finally {
    await fixed.close()
  }
}

async function accept(
  fixed: PullRequestFix,
  {
    name,
    branch,
    target,
    token,
    identity,
  }: {
    name: string
    branch: string
    target: PullRequestFixTarget
    token: string
    identity: GitIdentity
  },
  command: FixCommand & { ref: PullRequestRef; yes: boolean },
  deps: PullRequestFixCommandDeps,
): Promise<void> {
  if (fixed.diff !== '') deps.stdout.write(`\n${toTerminalText(fixed.diff)}`)
  deps.stdout.write(`\n${formatFixReport(fixed)}`)
  for (const warning of formatFixWarnings(fixed)) deps.stderr.write(`${warning}\n`)
  if (fixed.ai?.status === 'failed') throw fixed.ai.error
  if (fixed.changedFiles.length === 0) {
    deps.stdout.write(`Nothing changed: nothing to commit to ${name}.\n`)
    return
  }
  const destination = `${toTerminalText(target.pullRequest.repo)}:${branch}`
  const question = `Commit and push to ${destination}? [y/N] `
  if (!command.yes && !(await confirm(deps.stdin, deps.stderr, question))) {
    deps.stderr.write('Nothing committed or pushed: the work tree is removed.\n')
    return
  }
  const { ref } = command
  const commit = await pushPullRequestFix(target, fixed, {
    readHead: async () => (await deps.fetchPullRequestMetadata({ ...ref, token })).headSha,
    commit: (input) => commitWorkTree({ ...input, identity, env: deps.env }),
    push: (input) =>
      (deps.pushCommit ?? pushCommit)({
        ...input,
        owner: ref.owner,
        repo: ref.repo,
        token,
        env: deps.env,
      }),
  })
  deps.stdout.write(`Pushed ${commit} to ${destination}.\n`)
  if (await cloneIsOn(target, deps)) {
    deps.stdout.write(`Your clone is on ${branch}: run git pull to bring the fix in.\n`)
  }
}

async function cloneIsOn(
  target: PullRequestFixTarget,
  deps: PullRequestFixCommandDeps,
): Promise<boolean> {
  try {
    const local = await (deps.openLocalGit ?? openLocalGit)({ dir: deps.cwd, env: deps.env })
    const [origin, branch] = await Promise.all([local.origin(), local.branch()])
    return (
      `${origin.owner}/${origin.repo}`.toLowerCase() === target.pullRequest.repo.toLowerCase() &&
      branch === target.pullRequest.headRef
    )
  } catch {
    return false
  }
}

function branchOf(target: PullRequestFixTarget): string {
  return toTerminalText(target.pullRequest.headRef)
}
