import { reviewDetailOf } from '../app/read-history.js'
import { ReviewCancelledError } from '../app/review-and-publish.js'
import { submitRequest } from '../app/submit-request.js'
import { dataFiles } from '../config/data-paths.js'
import { loadTopLevelUserLayers } from '../config/user-config.js'
import type { ReviewProgressSink } from '../app/review-progress.js'
import type {
  EnqueuedReview,
  OpenPullRequests,
  PullRequestTarget,
  RequestedReview,
  ReviewMode,
} from '../app/requested-review.js'
import { InvalidPullRequestRefError } from '../github/errors.js'
import type { PullListing } from '../github/list-pull-requests.js'
import { parsePullRequestRef, splitRepoName } from '../github/pull-request-ref.js'
import type { RepositoryFilesOptions } from '../github/repository-files.js'
import { childScope } from '../process/run-command.js'
import type { ChildScope } from '../process/run-command.js'
import { readGitHubToken } from './github-token.js'
import type { GitHubTokenDeps } from './github-token.js'
import { historyRun } from './history-run.js'
import { prepareReview, runManualReview } from './manual-review.js'
import type { ManualReviewDeps } from './manual-review.js'
import { requireWatchSettings, submitDeps } from './request-wiring.js'
import type { RequestWiringDeps } from './request-wiring.js'
import { reviewRunJson } from './review-wiring.js'

export interface AppReviewDeps extends ManualReviewDeps, RequestWiringDeps, GitHubTokenDeps {
  listOpenPullRequests: (
    options: RepositoryFilesOptions & { etag?: string },
  ) => Promise<PullListing>
  lockHolder: (path: string) => Promise<number | undefined>
  childScope?: () => ChildScope
}

export interface AppReview {
  parsePullRequest(text: string): PullRequestTarget | undefined
  readOpenPullRequests(repo: string): Promise<OpenPullRequests>
  reviewPullRequest(
    target: PullRequestTarget,
    mode: ReviewMode,
    onProgress: ReviewProgressSink,
    signal?: AbortSignal,
  ): Promise<RequestedReview>
  enqueueReview(target: PullRequestTarget): Promise<EnqueuedReview>
  reviewsRunning(): boolean
}

export function appReview(deps: AppReviewDeps): AppReview {
  let running = 0
  const reviewPullRequest: AppReview['reviewPullRequest'] = async (
    target,
    mode,
    onProgress,
    signal,
  ) => {
    const token = await readGitHubToken(deps)
    if (token === undefined) return { status: 'no-token' }
    if (mode === 'publish') {
      const holder = await deps.lockHolder(dataFiles(deps.env, deps.home).lock)
      if (holder !== undefined) return { status: 'watch-running', pid: holder }
    }
    if (signal?.aborted === true) return { status: 'cancelled' }
    const children = (deps.childScope ?? childScope)()
    const kill = () => children.kill()
    signal?.addEventListener('abort', kill, { once: true })
    try {
      const { run, meta, history } = await children.run(async () =>
        runManualReview(
          await prepareReview(target, token, { detached: true }, deps),
          {
            force: false,
            dryRun: mode === 'look',
            waitCi: false,
            options: {},
            ...(signal === undefined ? {} : { signal }),
          },
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
        ),
      )
      const detail = reviewDetailOf(historyRun(run, reviewRunJson(run), meta), [])
      return { status: 'reviewed', detail, history }
    } catch (error) {
      if (error instanceof ReviewCancelledError) return { status: 'cancelled' }
      throw error
    } finally {
      signal?.removeEventListener('abort', kill)
    }
  }
  return {
    reviewsRunning: () => running > 0,
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
    reviewPullRequest: async (...request) => {
      running += 1
      try {
        return await reviewPullRequest(...request)
      } finally {
        running -= 1
      }
    },
    enqueueReview: async ({ owner, repo, number }) => {
      const settings = requireWatchSettings(await loadTopLevelUserLayers(deps))
      const token = await readGitHubToken(deps)
      if (token === undefined) return { status: 'no-token' }
      const history = await deps.openHistoryStore(dataFiles(deps.env, deps.home).history)
      try {
        const result = await submitRequest(
          { repo: `${owner}/${repo}`, number, source: 'enqueue', publish: 'pr' },
          submitDeps(history, settings, token, deps),
        )
        return { status: 'submitted', result }
      } finally {
        history.close()
      }
    },
  }
}
