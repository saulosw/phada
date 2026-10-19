import type { ConfigLayer } from '../config/types.js'
import type { ReviewComment } from '../github/create-review.js'
import type { PullRequestRef } from '../github/pull-request-ref.js'
import type { PullRequestReviewState } from '../github/pull-request-reviews.js'
import type { PullRequest } from '../github/pull-request.js'
import { decideRun } from '../publish/decide-run.js'
import { planPublication } from '../publish/plan-publication.js'
import type { PublicationPlan, SkipReason } from '../publish/types.js'
import { diffFingerprint } from '../review/diff-fingerprint.js'
import type { ReviewResult } from '../review/types.js'
import { loadPullRequestContext, reviewPullRequest } from './review-pull-request.js'
import type {
  PullRequestReview,
  PullRequestReviewDeps,
  ReviewOptions,
} from './review-pull-request.js'

export interface RenderedReview {
  body: string
  comments: ReviewComment[]
}

export type PublicationResult =
  | { status: 'published'; url: string }
  | { status: 'dry-run' }
  | { status: 'not-published' }
  | { status: 'superseded'; headSha: string }
  | { status: 'closed-or-draft' }
  | { status: 'failed'; error: unknown }

export type ReviewRun =
  | { status: 'skipped'; pullRequest: PullRequest; reason: SkipReason }
  | {
      status: 'nothing'
      pullRequest: PullRequest
      reviewed: PullRequestReview
      rendered?: RenderedReview
      publication?: PublicationResult
    }
  | {
      status: 'reviewed'
      pullRequest: PullRequest
      reviewed: PullRequestReview
      plan: PublicationPlan
      rendered: RenderedReview
      publication: PublicationResult
      wouldSkip?: SkipReason
    }

export type HeadCheck = 'current' | 'closed-or-draft' | { superseded: string }

export interface ReviewAndPublishInput {
  ref: PullRequestRef
  mode: 'manual' | 'watch'
  force: boolean
  dryRun: boolean
  publish: boolean
  options: ReviewOptions
  userLayers: readonly ConfigLayer[]
  userMcpServers: readonly string[]
}

export interface ReviewAndPublishEvents {
  fetched(pullRequest: PullRequest): void
  reviewed(review: PullRequestReview, pullRequest: PullRequest): void
  publishing(): void
}

export interface ReviewAndPublishDeps {
  fetchPullRequest(ref: PullRequestRef): Promise<PullRequest>
  fetchReviewState(ref: PullRequestRef): Promise<PullRequestReviewState>
  reviewDeps(pullRequest: PullRequest): PullRequestReviewDeps
  render: {
    review(result: ReviewResult, plan: PublicationPlan, language?: string): RenderedReview
    ignoredOnly(
      headSha: string,
      ignored: readonly string[],
      language: string | undefined,
      diff: string,
    ): RenderedReview
  }
  createReview(pullRequest: PullRequest, rendered: RenderedReview): Promise<{ url: string }>
  checkHead?(pullRequest: PullRequest): Promise<HeadCheck>
  events: ReviewAndPublishEvents
}

export async function reviewAndPublish(
  input: ReviewAndPublishInput,
  deps: ReviewAndPublishDeps,
): Promise<ReviewRun> {
  const pullRequest = await deps.fetchPullRequest(input.ref)
  deps.events.fetched(pullRequest)
  if (input.mode === 'watch' && (pullRequest.state === 'closed' || pullRequest.draft)) {
    return { status: 'skipped', pullRequest, reason: { kind: 'closed-or-draft' } }
  }
  const state = await deps.fetchReviewState(input.ref)
  const runOptions = {
    headSha: pullRequest.headSha,
    force: input.force,
    dryRun: input.dryRun,
    skipReviewedCommits: input.mode === 'watch',
  }
  const early = decideRun(state, runOptions)
  if (early.action === 'skip') return { status: 'skipped', pullRequest, reason: early.reason }

  const reviewDeps = deps.reviewDeps(pullRequest)
  const review = {
    pullRequest,
    userLayers: input.userLayers,
    userMcpServers: input.userMcpServers,
    options: input.options,
  }
  const loaded = await loadPullRequestContext(review, reviewDeps)
  const fingerprint = diffFingerprint(loaded.diff)
  const decision = decideRun(state, {
    ...runOptions,
    diff: { fingerprint, ignoredOnly: loaded.context.ignored.length > 0 },
  })
  if (decision.action === 'skip') {
    return { status: 'skipped', pullRequest, reason: decision.reason }
  }

  const reviewed = await reviewPullRequest({ ...review, loaded }, reviewDeps)
  const { outcome } = reviewed
  if (outcome.status === 'skipped') {
    if (outcome.reason !== 'all-ignored') {
      deps.events.reviewed(reviewed, pullRequest)
      return { status: 'nothing', pullRequest, reviewed }
    }
    const rendered = deps.render.ignoredOnly(
      pullRequest.headSha,
      reviewed.context.context.ignored,
      reviewed.language,
      fingerprint,
    )
    deps.events.reviewed(reviewed, pullRequest)
    return {
      status: 'nothing',
      pullRequest,
      reviewed,
      rendered,
      publication: await publish(input, deps, pullRequest, rendered),
    }
  }

  const plan = planPublication(outcome.result.findings, state)
  const rendered = deps.render.review(outcome.result, plan, reviewed.language)
  deps.events.reviewed(reviewed, pullRequest)
  return {
    status: 'reviewed',
    pullRequest,
    reviewed,
    plan,
    rendered,
    publication: await publish(input, deps, pullRequest, rendered),
    ...(decision.wouldSkip === undefined ? {} : { wouldSkip: decision.wouldSkip }),
  }
}

async function publish(
  input: ReviewAndPublishInput,
  deps: ReviewAndPublishDeps,
  pullRequest: PullRequest,
  rendered: RenderedReview,
): Promise<PublicationResult> {
  if (input.dryRun) return { status: 'dry-run' }
  if (!input.publish) return { status: 'not-published' }
  try {
    const head = (await deps.checkHead?.(pullRequest)) ?? 'current'
    if (head === 'closed-or-draft') return { status: 'closed-or-draft' }
    if (head !== 'current') return { status: 'superseded', headSha: head.superseded }
    deps.events.publishing()
    const created = await deps.createReview(pullRequest, rendered)
    return { status: 'published', url: created.url }
  } catch (error) {
    return { status: 'failed', error }
  }
}
