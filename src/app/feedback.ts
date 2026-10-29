import type { PullRequestReviewState } from '../github/pull-request-reviews.js'
import { findingFingerprint, threadFeedback } from '../publish/feedback.js'
import type {
  DuePull,
  FeedbackObservation,
  HistoryStore,
  SignalSource,
} from '../store/history-store.js'
import type { Finding } from '../review/types.js'
import { errorMessage } from './error-message.js'
import type { ReviewRun } from './review-and-publish.js'

export interface FeedbackMeta {
  runId?: number
  source: 'watch' | 'manual'
  now: string
}

export interface FeedbackRefreshDeps {
  history: HistoryStore
  fetchReviewState(pull: DuePull): Promise<PullRequestReviewState>
  isNotFound(error: unknown): boolean
  isRateLimited(error: unknown): boolean
  stopRequested?(): boolean
  now(): string
  events: {
    observed(pull: DuePull, threads: number): void
    warning(message: string): void
  }
}

export function recordReviewFeedback(
  history: HistoryStore,
  run: ReviewRun,
  meta: FeedbackMeta,
): void {
  const published =
    run.status === 'reviewed' && run.publication.status === 'published' ? run.plan.comments : []
  recordFeedback(history, run.pullRequest, run.reviewState, published, meta)
}

export function recordFeedback(
  history: HistoryStore,
  pullRequest: { repo: string; number: number; headSha: string },
  reviewState: PullRequestReviewState | undefined,
  published: readonly Finding[],
  { runId, source, now }: FeedbackMeta,
): void {
  if (reviewState !== undefined) {
    history.observeFeedback(
      observation(pullRequest.repo, pullRequest.number, reviewState, source, now),
    )
  }
  if (published.length === 0) return
  history.recordPublished(
    published.map((finding) => ({
      repo: pullRequest.repo,
      number: pullRequest.number,
      commitSha: pullRequest.headSha,
      fingerprint: findingFingerprint(finding.file, finding.title),
      file: finding.file,
      line: finding.line,
      title: finding.title,
      severity: finding.severity,
      confidence: finding.confidence,
      ...(finding.rule === undefined ? {} : { rule: finding.rule }),
      ...(runId === undefined ? {} : { runId }),
      publishedAt: now,
    })),
  )
}

export async function refreshFeedback(
  pulls: readonly DuePull[],
  source: 'watch' | 'refresh',
  deps: FeedbackRefreshDeps,
): Promise<{ observed: number; failed: number }> {
  let observed = 0
  let failed = 0
  for (const [index, pull] of pulls.entries()) {
    if (deps.stopRequested?.() === true) break
    let state: PullRequestReviewState
    try {
      state = await deps.fetchReviewState(pull)
    } catch (error) {
      if (deps.isNotFound(error)) {
        deps.history.observeFeedback({
          ...pull,
          pullState: 'closed',
          observedAt: deps.now(),
          source,
          threads: [],
        })
        observed++
        continue
      }
      if (deps.isRateLimited(error)) {
        deps.events.warning(
          `${pull.repo}#${pull.number}: ${errorMessage(error)}; the other pull requests wait for the next refresh`,
        )
        failed += pulls.length - index
        break
      }
      deps.events.warning(`${pull.repo}#${pull.number}: ${errorMessage(error)}`)
      failed++
      continue
    }
    const seen = observation(pull.repo, pull.number, state, source, deps.now())
    deps.history.observeFeedback(seen)
    deps.events.observed(pull, seen.threads.length)
    observed++
  }
  return { observed, failed }
}

export function observation(
  repo: string,
  number: number,
  state: PullRequestReviewState,
  source: SignalSource,
  now: string,
): FeedbackObservation {
  return {
    repo,
    number,
    pullState: state.pullState,
    observedAt: now,
    source,
    threads: threadFeedback(state),
  }
}
