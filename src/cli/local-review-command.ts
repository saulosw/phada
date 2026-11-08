import { reviewLocalChanges } from '../app/local-review.js'
import type { ReviewedLocalChanges, LocalRun } from '../app/local-review.js'
import type { ReviewOptions } from '../app/review-pull-request.js'
import type { ReviewProgressSink } from '../app/review-progress.js'
import { repositoryCache } from '../config/cache-paths.js'
import type { ConfigLayer } from '../config/types.js'
import type { PullRequest } from '../github/pull-request.js'
import { openLocalGit } from '../repository/local-git.js'
import type { LocalGit, LocalGitOptions } from '../repository/local-git.js'
import type { HistorySave } from '../app/requested-review.js'
import { localHistoryRun } from './history-run.js'
import { prepareProvider, saveRunRecord } from './manual-review.js'
import type { HistorySaveDeps } from './manual-review.js'
import { localReviewJson, pullRequestReviewDeps } from './review-wiring.js'
import type { ReviewWiringDeps } from './review-wiring.js'

export interface LocalReviewRunDeps extends ReviewWiringDeps, HistorySaveDeps {
  clock: () => Date
  openLocalGit?: (options: LocalGitOptions) => Promise<LocalGit>
}

export interface LocalReviewRequest {
  cwd: string
  token: string
  base?: string
  uncommitted: boolean
  provider?: string
  model?: string
  detached?: boolean
  options: ReviewOptions
  signal?: AbortSignal
}

export interface LocalReviewReport {
  progress: ReviewProgressSink
  started?: (local: LocalRun, pullRequest: PullRequest) => void
}

export interface LocalReviewRun {
  review: ReviewedLocalChanges
  userLayers: readonly ConfigLayer[]
  provider: string
  model?: string
  startedAt: string
  finishedAt: string
  history: HistorySave
}

export async function runLocalReview(
  request: LocalReviewRequest,
  deps: LocalReviewRunDeps,
  report: LocalReviewReport,
): Promise<LocalReviewRun> {
  const startedAt = deps.clock().toISOString()
  const { token } = request
  const open = deps.openLocalGit ?? openLocalGit
  const local = await open({ dir: request.cwd, env: deps.env })
  const origin = await local.origin()
  const { userLayers, choice, mcp } = await prepareProvider(
    origin,
    {
      ...(request.provider === undefined ? {} : { provider: request.provider }),
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.detached === true ? { detached: true } : {}),
    },
    deps,
  )
  const review = await reviewLocalChanges(
    {
      ...(request.base === undefined ? {} : { base: request.base }),
      uncommitted: request.uncommitted,
      userLayers,
      mcp,
      options: request.options,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    },
    {
      local,
      readRepository: (owner, repo) => deps.fetchRepository({ owner, repo, token }),
      reviewDeps: ({ repository, local: run, pullRequest, sources }) => {
        report.started?.(run, pullRequest)
        const { owner, repo } = repository
        const made = pullRequestReviewDeps(
          deps,
          { owner, repo, token },
          choice,
          pullRequest,
          report.progress,
        )
        const { mirror } = repositoryCache(deps.env, deps.home, owner, repo)
        return {
          ...made,
          contextSources: { ...made.contextSources, ...sources },
          openMirror: () =>
            deps.openMirror({
              dir: mirror,
              owner,
              repo,
              token,
              env: deps.env,
              remoteUrl: local.root,
            }),
        }
      },
    },
  )
  const meta = {
    provider: choice.provider,
    ...(choice.model === undefined ? {} : { model: choice.model }),
    startedAt,
    finishedAt: deps.clock().toISOString(),
  }
  const history = await saveRunRecord(deps, userLayers, () =>
    localHistoryRun(review, localReviewJson(review), meta),
  )
  return { review, userLayers, ...meta, history }
}
