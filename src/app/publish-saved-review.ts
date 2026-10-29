import type { PullRequestRef } from '../github/pull-request-ref.js'
import type { PullRequestReviewState } from '../github/pull-request-reviews.js'
import { decideRun } from '../publish/decide-run.js'
import { planPublication } from '../publish/plan-publication.js'
import type { PublicationPlan, SkipReason } from '../publish/types.js'
import type { RunRecord, RunStatus } from '../store/history-store.js'
import { resolveFixed } from './review-and-publish.js'
import type {
  RenderedReview,
  ResolvedThreads,
  ResolveDeps,
  ReviewAndPublishDeps,
} from './review-and-publish.js'
import { objectOf, parseJson } from './stored-json.js'
import { storedReview } from './stored-review.js'
import type { StoredReview } from './stored-review.js'

export interface PublishSavedReviewInput {
  id: number
  force: boolean
}

export interface PublishSavedReviewDeps extends ResolveDeps {
  readRun(id: number): RunRecord | undefined
  fetchHead(ref: PullRequestRef): Promise<{ headSha: string }>
  fetchReviewState(ref: PullRequestRef): Promise<PullRequestReviewState>
  render: Pick<ReviewAndPublishDeps['render'], 'review' | 'resolvedReply'>
  createReview(
    ref: PullRequestRef,
    commitSha: string,
    rendered: RenderedReview,
  ): Promise<{ url: string }>
}

export type PublishRefusal =
  | { kind: 'not-found' }
  | { kind: 'not-a-dry-run'; status: RunStatus; url?: string }
  | { kind: 'nothing-to-publish' }
  | { kind: 'outdated' }
  | { kind: 'head-moved'; from: string; to: string }

export interface SavedReview {
  run: RunRecord & { id: number }
  json: Record<string, unknown>
  stored: StoredReview
  ref: PullRequestRef
}

export type SavedPublication =
  | { status: 'refused'; refusal: PublishRefusal }
  | {
      status: 'skipped'
      saved: SavedReview
      reason: SkipReason
      reviewState: PullRequestReviewState
    }
  | {
      status: 'published'
      saved: SavedReview
      url: string
      plan: PublicationPlan
      rendered: RenderedReview
      resolved: ResolvedThreads
      reviewState: PullRequestReviewState
      headMoved?: string
    }

export async function publishSavedReview(
  { id, force }: PublishSavedReviewInput,
  deps: PublishSavedReviewDeps,
): Promise<SavedPublication> {
  const saved = savedReview(id, deps)
  if ('kind' in saved) return { status: 'refused', refusal: saved }
  const { stored, ref } = saved
  const reviewedSha = stored.pullRequest.headSha
  const { headSha } = await deps.fetchHead(ref)
  const moved = headSha === reviewedSha ? undefined : headSha
  if (moved !== undefined && !force) {
    return { status: 'refused', refusal: { kind: 'head-moved', from: reviewedSha, to: moved } }
  }
  const reviewState = await deps.fetchReviewState(ref)
  const { diffFingerprint } = stored.result.target
  const decision = decideRun(reviewState, {
    headSha: reviewedSha,
    force,
    dryRun: false,
    skipReviewedCommits: true,
    ...(diffFingerprint === undefined ? {} : { diff: diffFingerprint }),
  })
  if (decision.action === 'skip') {
    return { status: 'skipped', saved, reason: decision.reason, reviewState }
  }
  const open = new Set(
    reviewState.threads.filter(({ isResolved }) => !isResolved).map(({ id }) => id),
  )
  const fixed = stored.wouldResolve.filter(
    ({ verdict, threadId }) => verdict === 'fixed' && open.has(threadId),
  )
  const plan = planPublication(
    stored.result.findings,
    reviewState,
    new Set(fixed.map(({ threadId }) => threadId)),
  )
  const rendered = deps.render.review(stored.result, plan, stored.language, stored.ci)
  const resolved = await resolveFixed(deps, reviewedSha, fixed, stored.language)
  const { url } = await deps.createReview(ref, reviewedSha, rendered)
  return {
    status: 'published',
    saved,
    url,
    plan,
    rendered,
    resolved,
    reviewState,
    ...(moved === undefined ? {} : { headMoved: moved }),
  }
}

function savedReview(id: number, deps: PublishSavedReviewDeps): SavedReview | PublishRefusal {
  const run = deps.readRun(id)
  if (run === undefined) return { kind: 'not-found' }
  if (run.status !== 'dry-run') {
    return {
      kind: 'not-a-dry-run',
      status: run.status,
      ...(run.url === undefined ? {} : { url: run.url }),
    }
  }
  const record = objectOf(parseJson(run.resultJson))
  if (record === undefined) return { kind: 'outdated' }
  if (record.status === 'skipped') return { kind: 'nothing-to-publish' }
  const stored = storedReview(record)
  if (stored === undefined) return { kind: 'outdated' }
  const [owner = '', repo = ''] = stored.pullRequest.repo.split('/')
  return {
    run: { ...run, id },
    json: record,
    stored,
    ref: { owner, repo, number: stored.pullRequest.number },
  }
}
