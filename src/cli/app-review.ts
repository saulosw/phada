import { reviewDetailOf } from '../app/read-history.js'
import type { ReviewProgressSink } from '../app/review-progress.js'
import type {
  OpenPullRequests,
  PullRequestTarget,
  RequestedReview,
  ReviewMode,
} from '../app/requested-review.js'
import { InvalidPullRequestRefError } from '../github/errors.js'
import type { PullListing } from '../github/list-pull-requests.js'
import { parsePullRequestRef, splitRepoName } from '../github/pull-request-ref.js'
import type { RepositoryFilesOptions } from '../github/repository-files.js'
import { readGitHubToken } from './github-token.js'
import type { GitHubTokenDeps } from './github-token.js'
import { historyRun } from './history-run.js'
import { prepareReview, runManualReview } from './manual-review.js'
import type { ManualReviewDeps } from './manual-review.js'
import { reviewRunJson } from './review-wiring.js'

export interface AppReviewDeps extends ManualReviewDeps, GitHubTokenDeps {
  listOpenPullRequests: (
    options: RepositoryFilesOptions & { etag?: string },
  ) => Promise<PullListing>
}

export interface AppReview {
  parsePullRequest(text: string): PullRequestTarget | undefined
  readOpenPullRequests(repo: string): Promise<OpenPullRequests>
  reviewPullRequest(
    target: PullRequestTarget,
    mode: ReviewMode,
    onProgress: ReviewProgressSink,
  ): Promise<RequestedReview>
}

export function appReview(deps: AppReviewDeps): AppReview {
  return {
    parsePullRequest: (text) => {
      try {
        return parsePullRequestRef(text)
      } catch (error) {
        if (error instanceof InvalidPullRequestRefError) return undefined
        throw error
      }
    },
    readOpenPullRequests: async (repo) => {
      const token = await readGitHubToken(deps)
      if (token === undefined) return { status: 'no-token' }
      const listing = await deps.listOpenPullRequests({ ...splitRepoName(repo), token })
      const pulls = listing.status === 'ok' ? listing.pulls : []
      return {
        status: 'read',
        repo,
        pulls: pulls.map(({ number, title, author, draft }) => ({
          number,
          title: title ?? null,
          author,
          draft,
        })),
      }
    },
    reviewPullRequest: async (target, mode, onProgress) => {
      const token = await readGitHubToken(deps)
      if (token === undefined) return { status: 'no-token' }
      const prepared = await prepareReview(target, token, { detached: true }, deps)
      const { run, meta, history } = await runManualReview(
        prepared,
        { force: false, dryRun: mode === 'look', waitCi: false, options: {} },
        deps,
        {
          progress: onProgress,
          reviewed: ({ outcome }) => {
            if (outcome.status !== 'reviewed') return
            for (const message of outcome.result.warnings ?? []) {
              onProgress({ kind: 'warning', message })
            }
          },
        },
      )
      const detail = reviewDetailOf(historyRun(run, reviewRunJson(run), meta), [])
      return { status: 'reviewed', detail, history }
    },
  }
}
