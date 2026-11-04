import type { PullRequestReviewState } from '../github/pull-request-reviews.js'
import { findingFingerprint, threadFeedback } from '../publish/feedback.js'
import type {
  DuePull,
  FeedbackObservation,
  HistoryStore,
  SignalSource,
} from '../store/history-store.js'
import type { Extractor } from '../repo-map/extract.js'
import type { Finding } from '../review/types.js'
import { codeElements } from './code-elements.js'
import type { ReadFileAt } from './code-elements.js'
import { errorMessage } from './error-message.js'
import { comparedCommits, harvestMisses } from './harvest-misses.js'
import type { CompareCommits } from './harvest-misses.js'
import type { ReviewRun } from './review-and-publish.js'

export interface FeedbackMeta {
  runId?: number
  source: 'watch' | 'manual'
  now: string
}

export interface FeedbackRefreshDeps {
  history: HistoryStore
  fetchReviewState(pull: DuePull): Promise<PullRequestReviewState>
  missBots(repo: string): Promise<readonly string[]>
  readFile: ReadFileAt
  extractor: Extractor
  compare: CompareCommits
  isNotFound(error: unknown): boolean
  isRateLimited(error: unknown): boolean
  stopRequested?(): boolean
  now(): string
  events: {
    observed(pull: DuePull, threads: number, misses: number): void
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
  const elements = codeElements(deps.readFile, deps.extractor)
  const compare = comparedCommits(deps.compare)
  for (const [index, pull] of pulls.entries()) {
    if (deps.stopRequested?.() === true) break
    try {
      const bots = await deps.missBots(pull.repo)
      const state = await deps.fetchReviewState(pull)
      const misses = await harvestMisses(deps.history, {
        pull,
        state,
        bots,
        elements,
        compare,
        now: deps.now(),
      })
      const seen = observation(pull.repo, pull.number, state, source, deps.now())
      deps.history.observeFeedback(seen)
      deps.events.observed(pull, seen.threads.length, misses)
      observed++
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
    }
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
