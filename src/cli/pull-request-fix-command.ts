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
import type { CommandOf } from './args.js'
import type { FixCommand, FixCommandDeps } from './local-fix-command.js'
import { fixProvider, reportFix, startFix, workingFiles } from './fix-wiring.js'
import { formatNumberedList } from './format-fix.js'
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

type PullRequestFixCommand = FixCommand & Required<Pick<CommandOf<'fix'>, 'ref' | 'yes'>>

interface PushPlan {
  ref: PullRequestRef
  target: PullRequestFixTarget
  token: string
  identity: GitIdentity
  yes: boolean
}

export async function runPullRequestFix(
  command: PullRequestFixCommand,
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
  const started = await startFix(
    command,
    {
      findings: target.findings,
      nothingToFix: `Nothing to fix: ${name} has no open Phada comment.`,
      unknownNumber: (number, last) =>
        `No comment ${number} on ${name}: its comments go from 1 to ${last}.`,
      list: formatNumberedList(
        `Open Phada comments on ${name} (${branchOf(target)}):`,
        target.findings,
      ),
      prepare: async () => ({
        identity: await readGitIdentity({ dir: deps.cwd, env: deps.env }),
        provider: await fixProvider(ref, command, deps),
      }),
    },
    deps.stdout,
  )
  if (started === undefined) return
  const { identity, provider } = started.prepared
  const plan: PushPlan = { ref, target, token, identity, yes: command.yes }
  deps.onSignal(() => deps.abort(130))
  const { mirror } = repositoryCache(deps.env, deps.home, ref.owner, ref.repo)
  const fixed = await fixPullRequest(target, started.picked, {
    openMirror: () => deps.openMirror({ dir: mirror, ...repository, env: deps.env }),
    openTree: (dir) => (deps.openLocalGit ?? openLocalGit)({ dir, env: deps.env }),
    files: (root) => workingFiles(root, nodeFileSystem),
    env: deps.env,
    warning: (message) => deps.stderr.write(`Warning: ${toTerminalText(message)}\n`),
    provider,
  })
  try {
    if (showFix(fixed, name, deps)) await commitAndPush(fixed, plan, deps)
  } finally {
    await fixed.close()
  }
}

function showFix(fixed: PullRequestFix, name: string, deps: PullRequestFixCommandDeps): boolean {
  if (fixed.diff !== '') deps.stdout.write(`\n${toTerminalText(fixed.diff)}`)
  reportFix(fixed, deps)
  if (fixed.changedFiles.length === 0) {
    deps.stdout.write(`Nothing changed: nothing to commit to ${name}.\n`)
    return false
  }
  return true
}

async function commitAndPush(
  fixed: PullRequestFix,
  { ref, target, token, identity, yes }: PushPlan,
  deps: PullRequestFixCommandDeps,
): Promise<void> {
  const branch = branchOf(target)
  const destination = `${toTerminalText(target.pullRequest.repo)}:${branch}`
  const question = `Commit and push to ${destination}? [y/N] `
  if (!yes && !(await confirm(deps.stdin, deps.stderr, question))) {
    deps.stderr.write('Nothing committed or pushed: the work tree is removed.\n')
    return
  }
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
