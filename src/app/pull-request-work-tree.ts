import { join } from 'node:path'
import type { PullRequestMetadata } from '../github/pull-request.js'
import { openWorkDir, sweepOrphanWorkDirs } from '../process/work-dirs.js'
import type { GitMirror } from '../repository/git-mirror.js'
import { materializeWorkTree } from '../repository/work-tree.js'
import type { WorkTree, WorkTreeInput } from '../repository/work-tree.js'

export type PullRequestHead = Pick<
  PullRequestMetadata,
  'headSha' | 'baseSha' | 'baseRef' | 'headRef' | 'number' | 'stats'
>

export interface PullRequestWorkTreeDeps {
  env: NodeJS.ProcessEnv
  warning(message: string): void
}

export async function openFreshWorkDir(tempRoot: string | undefined): Promise<string> {
  await sweepOrphanWorkDirs(tempRoot)
  return openWorkDir(tempRoot)
}

export async function materializePullRequest(
  mirror: GitMirror,
  workDir: string,
  pullRequest: PullRequestHead,
  content: Pick<WorkTreeInput, 'diff' | 'files'>,
  deps: PullRequestWorkTreeDeps,
): Promise<WorkTree> {
  const tree = await materializeWorkTree(
    mirror,
    {
      dir: join(workDir, 'repo'),
      headSha: pullRequest.headSha,
      baseSha: pullRequest.baseSha,
      baseRef: pullRequest.baseRef,
      headRef: pullRequest.headRef,
      number: pullRequest.number,
      commits: pullRequest.stats.commits,
      ...content,
    },
    { env: deps.env },
  )
  for (const warning of tree.warnings) deps.warning(warning)
  return tree
}
