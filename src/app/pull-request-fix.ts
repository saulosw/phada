import type { PullRequestReviewState } from '../github/pull-request-reviews.js'
import type { PullRequestMetadata } from '../github/pull-request.js'
import type { RepositoryInfo } from '../github/repository.js'
import { closeWorkDir } from '../process/work-dirs.js'
import type { ReviewProvider } from '../providers/types.js'
import { threadFindings } from '../publish/thread-findings.js'
import type { ThreadFinding } from '../publish/thread-findings.js'
import type { GitMirror } from '../repository/git-mirror.js'
import type { LocalGit } from '../repository/local-git.js'
import { BranchMovedError } from '../repository/branch-moved.js'
import type { WorkingFiles } from './apply-file-suggestions.js'
import { fixFindings, leftAfterAi } from './fix-findings.js'
import type { FindingsFix, FixTree } from './fix-findings.js'
import { materializePullRequest, openFreshWorkDir } from './pull-request-work-tree.js'
import { singleLine } from './terminal-text.js'

export interface PullRequestFixReadDeps {
  fetchPullRequest(): Promise<PullRequestMetadata>
  fetchRepository(): Promise<RepositoryInfo>
  fetchReviewState(): Promise<PullRequestReviewState>
}

export interface PullRequestFixTarget {
  pullRequest: PullRequestMetadata
  findings: ThreadFinding[]
}

export type WorkTreeGit = FixTree & Pick<LocalGit, 'diff'>

export interface PullRequestFixDeps {
  openMirror(): Promise<GitMirror>
  openTree(dir: string): Promise<WorkTreeGit>
  files(root: string): WorkingFiles
  provider: ReviewProvider
  env: NodeJS.ProcessEnv
  warning(message: string): void
  tempRoot?: string
}

export interface PullRequestFix extends FindingsFix<ThreadFinding> {
  dir: string
  tree: string
  diff: string
  close(): Promise<void>
}

export interface PushFixDeps {
  readHead(): Promise<string>
  commit(input: { dir: string; tree: string; message: string }): Promise<string>
  push(input: { dir: string; commit: string; branch: string }): Promise<void>
}

const MAX_FIX_DIFF_BYTES = 20_000_000
const FIX_COMMIT_SUBJECT = 'fix: address review comments'

export class ForkFixError extends Error {
  override readonly name = 'ForkFixError'

  constructor(pullRequest: Pick<PullRequestMetadata, 'repo' | 'number'>) {
    super(
      `${pullRequest.repo}#${pullRequest.number} comes from a fork: phada fix pushes only to a branch of ${pullRequest.repo}.`,
    )
  }
}

export class ClosedPullRequestFixError extends Error {
  override readonly name = 'ClosedPullRequestFixError'

  constructor(pullRequest: Pick<PullRequestMetadata, 'repo' | 'number'>) {
    super(
      `${pullRequest.repo}#${pullRequest.number} is closed: phada fix pushes only to an open pull request.`,
    )
  }
}

export class NoPushPermissionError extends Error {
  override readonly name = 'NoPushPermissionError'

  constructor(repo: string) {
    super(
      `Your GitHub token cannot push to ${repo}: phada fix commits to the branch of the pull request.`,
    )
  }
}

export async function readPullRequestFix(
  deps: PullRequestFixReadDeps,
): Promise<PullRequestFixTarget> {
  const pullRequest = await deps.fetchPullRequest()
  if (pullRequest.fromFork) throw new ForkFixError(pullRequest)
  if (pullRequest.state !== 'open') throw new ClosedPullRequestFixError(pullRequest)
  const repository = await deps.fetchRepository()
  if (repository.canPush !== true) throw new NoPushPermissionError(pullRequest.repo)
  const state = await deps.fetchReviewState()
  if (state.headSha !== pullRequest.headSha) {
    throw new BranchMovedError(pullRequest.repo, pullRequest.headRef)
  }
  return { pullRequest, findings: threadFindings(state) }
}

export async function fixPullRequest(
  target: PullRequestFixTarget,
  findings: readonly ThreadFinding[],
  deps: PullRequestFixDeps,
): Promise<PullRequestFix> {
  const { pullRequest } = target
  const workDir = await openFreshWorkDir(deps.tempRoot)
  const close = () => closeWorkDir(workDir)
  try {
    const workTree = await materializePullRequest(
      await deps.openMirror(),
      workDir,
      pullRequest,
      {},
      deps,
    )
    const git = await deps.openTree(workTree.dir)
    const fixed = await fixFindings(findings, {
      tree: git,
      files: deps.files(workTree.dir),
      provider: deps.provider,
    })
    const tree = await git.workingTree()
    const diff =
      fixed.changedFiles.length === 0
        ? ''
        : await git.diff(pullRequest.headSha, tree, { maxBytes: MAX_FIX_DIFF_BYTES })
    return { ...fixed, dir: workTree.dir, tree, diff, close }
  } catch (error) {
    await close()
    throw error
  }
}

export async function pushPullRequestFix(
  target: PullRequestFixTarget,
  fixed: PullRequestFix,
  deps: PushFixDeps,
): Promise<string> {
  const { pullRequest } = target
  if ((await deps.readHead()) !== pullRequest.headSha) {
    throw new BranchMovedError(pullRequest.repo, pullRequest.headRef)
  }
  const commit = await deps.commit({
    dir: fixed.dir,
    tree: fixed.tree,
    message: fixCommitMessage(fixed),
  })
  await deps.push({ dir: fixed.dir, commit, branch: pullRequest.headRef })
  return commit
}

export function fixCommitMessage(fixed: FindingsFix<ThreadFinding>): string {
  const handled = [...fixed.applied, ...leftAfterAi(fixed).fixed.map(({ item }) => item)].sort(
    (a, b) => a.number - b.number,
  )
  const lines = handled.map(
    ({ finding }) => `- ${singleLine(`${finding.file}:${finding.line} ${finding.title}`)}`,
  )
  return lines.length === 0
    ? `${FIX_COMMIT_SUBJECT}\n`
    : `${FIX_COMMIT_SUBJECT}\n\n${lines.join('\n')}\n`
}
