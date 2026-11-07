import type { ResolvedMcp } from '../config/mcp-servers.js'
import type { ConfigLayer } from '../config/types.js'
import type { ContextSources } from '../context/types.js'
import type { PullRequest } from '../github/pull-request.js'
import type { GitHubRepository, LocalBase, LocalGit } from '../repository/local-git.js'
import { localPullRequest } from './local-pull-request.js'
import { stopIfCancelled } from './review-cancelled.js'
import { BUILT_IN_SKILL } from './review-passes.js'
import type { PassPlan } from './review-passes.js'
import { reviewPullRequest } from './review-pull-request.js'
import { localRunName } from './run-target.js'
import type {
  PullRequestReview,
  PullRequestReviewDeps,
  ReviewOptions,
} from './review-pull-request.js'

const LOCAL_MIRROR_REF = 'refs/phada/local'

export type LocalSource = Pick<
  LocalGit,
  | 'branch'
  | 'head'
  | 'origin'
  | 'mergeBase'
  | 'diff'
  | 'stats'
  | 'commitMessages'
  | 'readTree'
  | 'readFile'
  | 'commitWorkingTree'
>

export interface LocalRepositoryInfo {
  private: boolean
  defaultBranch?: string
}

export type RepositorySources = Pick<ContextSources, 'readTree' | 'readRepoFile'>

export interface LocalReviewTarget {
  repository: GitHubRepository
  local: LocalRun
  pullRequest: PullRequest
  sources: RepositorySources
}

export interface LocalReviewInput {
  base?: string
  uncommitted: boolean
  userLayers: readonly ConfigLayer[]
  mcp: ResolvedMcp
  options: ReviewOptions
  signal?: AbortSignal
}

export interface LocalReviewDeps {
  local: LocalSource
  readRepository(owner: string, repo: string): Promise<LocalRepositoryInfo>
  reviewDeps(target: LocalReviewTarget): PullRequestReviewDeps
}

export interface LocalRun {
  repo: string
  branch?: string
  base: string
  baseRef: string
  head: string
  reviewed: string
  dirty: boolean
}

export interface ReviewedLocalChanges {
  local: LocalRun
  pullRequest: PullRequest
  reviewed: PullRequestReview
}

export class NoDefaultBranchError extends Error {
  override readonly name = 'NoDefaultBranchError'

  constructor(repo: string) {
    super(`${repo} has no default branch on GitHub; pass --base.`)
  }
}

export class NothingToReviewError extends Error {
  override readonly name = 'NothingToReviewError'

  constructor(branch: string, base: string) {
    super(`Nothing to review: ${branch} has no changes against ${base.slice(0, 7)}.`)
  }
}

const SYNTHETIC_MESSAGE = 'Uncommitted changes'

export async function reviewLocalChanges(
  input: LocalReviewInput,
  deps: LocalReviewDeps,
): Promise<ReviewedLocalChanges> {
  const { local } = deps
  const stop = () => stopIfCancelled(input.signal)
  const repository = await local.origin()
  const repo = `${repository.owner}/${repository.repo}`
  const info = await deps.readRepository(repository.owner, repository.repo)
  stop()
  const target = baseOf(input.base, info.defaultBranch, repo)
  const branch = await local.branch()
  const head = await local.head()
  const base = await local.mergeBase(head, target.base)
  stop()
  const synthetic = input.uncommitted ? await local.commitWorkingTree(SYNTHETIC_MESSAGE) : undefined
  const reviewed = synthetic ?? head
  const diff = await local.diff(base, reviewed)
  const name = localRunName(branch, head)
  if (diff.trim() === '') throw new NothingToReviewError(name, base)
  const messages = await local.commitMessages(base, head)
  const stats = await local.stats(base, reviewed)
  stop()
  const run: LocalRun = {
    repo,
    ...(branch === undefined ? {} : { branch }),
    base,
    baseRef: target.ref,
    head,
    reviewed,
    dirty: synthetic !== undefined,
  }
  const pullRequest = localPullRequest({
    ...run,
    private: info.private,
    messages,
    stats: { ...stats, commits: messages.length },
    diff,
  })
  const made = deps.reviewDeps({
    repository,
    local: run,
    pullRequest,
    sources: {
      readTree: () => local.readTree(base),
      readRepoFile: (path) => local.readFile(base, path),
    },
  })
  if (input.uncommitted && synthetic === undefined) {
    made.events.warning(`Nothing uncommitted: reviewing the commits of ${name}.`)
  }
  const result = await reviewPullRequest(
    {
      pullRequest,
      userLayers: input.userLayers,
      mcp: input.mcp,
      options: input.options,
      viewer: '',
      mirrorRef: LOCAL_MIRROR_REF,
      learnEdges: false,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
    { ...made, runsSkills: false, events: withTextSkillWarning(made) },
  )
  return { local: run, pullRequest, reviewed: result }
}

function baseOf(
  base: string | undefined,
  defaultBranch: string | undefined,
  repo: string,
): { base: LocalBase; ref: string } {
  if (base !== undefined) return { base: { ref: base }, ref: base }
  if (defaultBranch === undefined) throw new NoDefaultBranchError(repo)
  return { base: { defaultBranch }, ref: defaultBranch }
}

function withTextSkillWarning(deps: PullRequestReviewDeps): PullRequestReviewDeps['events'] {
  const { events } = deps
  if (deps.runsSkills !== true) return events
  return {
    ...events,
    passesPlanned: (plan: PassPlan[]) => {
      const skills = plan
        .filter(({ skill, status }) => skill !== BUILT_IN_SKILL && status === 'planned')
        .map(({ skill }) => skill)
      if (skills.length > 0) {
        events.warning(
          `${skills.length === 1 ? 'Skill' : 'Skills'} ${skills.join(', ')} ${skills.length === 1 ? 'runs' : 'run'} as text in a local review: native skills need a pull request.`,
        )
      }
      events.passesPlanned?.(plan)
    },
  }
}
