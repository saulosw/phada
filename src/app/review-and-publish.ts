import type { ResolvedMcp } from '../config/mcp-servers.js'
import type { ConfigLayer } from '../config/types.js'
import type { ComparedFile } from '../github/compare-commits.js'
import type { ReviewComment } from '../github/create-review.js'
import type { PullRequestRef } from '../github/pull-request-ref.js'
import type { PullComment, PullRequestReviewState } from '../github/pull-request-reviews.js'
import type { PullRequest } from '../github/pull-request.js'
import { buildConversation } from '../publish/conversation.js'
import { decideRun } from '../publish/decide-run.js'
import { resolvedMarker } from '../publish/markers.js'
import { planPublication } from '../publish/plan-publication.js'
import { threadsToRecheck, withChanges } from '../publish/recheck-candidates.js'
import type { Comparisons } from '../publish/recheck-candidates.js'
import type { Ci, CiSummary, Conversation, PublicationPlan, SkipReason } from '../publish/types.js'
import { diffFingerprint } from '../review/diff-fingerprint.js'
import type { RecheckThread, RecheckVerdict, ReviewResult } from '../review/types.js'
import { errorMessage } from './error-message.js'
import { readCi } from './read-ci.js'
import type { CiReaders } from './read-ci.js'
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

export interface ResolvedThreads {
  resolved: number
  failed: number
  total: number
}

export type PublicationResult =
  | { status: 'published'; url: string; resolved: ResolvedThreads }
  | { status: 'dry-run'; wouldResolve: RecheckVerdict[] }
  | { status: 'not-published' }
  | { status: 'superseded'; headSha: string }
  | { status: 'closed-or-draft' }
  | { status: 'failed'; error: unknown }

export type ReviewRun = (
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
) & { reviewState?: PullRequestReviewState }

export type HeadCheck = 'current' | 'closed-or-draft' | { superseded: string }

export interface ReviewAndPublishInput {
  ref: PullRequestRef
  mode: 'manual' | 'watch'
  force: boolean
  dryRun: boolean
  publish: boolean
  acceptDraft?: boolean
  options: ReviewOptions
  userLayers: readonly ConfigLayer[]
  mcp: ResolvedMcp
}

export interface ReviewAndPublishEvents {
  fetched(pullRequest: PullRequest): void
  reviewed(review: PullRequestReview, pullRequest: PullRequest): void
  publishing(): void
  warning(message: string): void
}

export interface ReviewAndPublishDeps {
  fetchPullRequest(ref: PullRequestRef): Promise<PullRequest>
  fetchReviewState(ref: PullRequestRef): Promise<PullRequestReviewState>
  fetchPullComments(ref: PullRequestRef): Promise<PullComment[]>
  ci: CiReaders
  reviewDeps(pullRequest: PullRequest): PullRequestReviewDeps
  render: {
    review(
      result: ReviewResult,
      plan: PublicationPlan,
      language?: string,
      ci?: CiSummary,
    ): RenderedReview
    ignoredOnly(
      headSha: string,
      ignored: readonly string[],
      language: string | undefined,
      diff: string,
    ): RenderedReview
    resolvedReply(headSha: string, reason: string, language?: string): string
  }
  createReview(pullRequest: PullRequest, rendered: RenderedReview): Promise<{ url: string }>
  compare(pullRequest: PullRequest, base: string): Promise<ComparedFile[]>
  replyAndResolve(threadId: string, body: string): Promise<void>
  checkHead?(pullRequest: PullRequest): Promise<HeadCheck>
  events: ReviewAndPublishEvents
}

export async function reviewAndPublish(
  input: ReviewAndPublishInput,
  deps: ReviewAndPublishDeps,
): Promise<ReviewRun> {
  const pullRequest = await deps.fetchPullRequest(input.ref)
  deps.events.fetched(pullRequest)
  if (
    input.mode === 'watch' &&
    (pullRequest.state === 'closed' || (pullRequest.draft && input.acceptDraft !== true))
  ) {
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
  if (early.action === 'skip')
    return { status: 'skipped', pullRequest, reason: early.reason, reviewState: state }

  const reviewDeps = deps.reviewDeps(pullRequest)
  const review = {
    pullRequest,
    userLayers: input.userLayers,
    mcp: input.mcp,
    options: input.options,
  }
  const loaded = await loadPullRequestContext(review, reviewDeps)
  const fingerprint = diffFingerprint(loaded.diff)
  const decision = decideRun(state, { ...runOptions, diff: fingerprint })
  if (decision.action === 'skip') {
    return { status: 'skipped', pullRequest, reason: decision.reason, reviewState: state }
  }

  const resolve = input.options.resolveThreads ?? loaded.options.resolveThreads ?? true
  const recheck = resolve ? await threadsWithChanges(state, pullRequest, deps) : []
  const conversation =
    (input.options.conversation ?? loaded.options.conversation ?? true)
      ? await readConversation(input.ref, state, pullRequest, deps)
      : undefined
  const ci: Ci | undefined =
    (input.options.ci ?? loaded.options.ci?.read ?? true)
      ? await readCi(deps.ci, pullRequest.headSha, loaded.options.ci?.checks, (message) =>
          deps.events.warning(message),
        )
      : undefined
  const reviewed = await reviewPullRequest(
    {
      ...review,
      loaded,
      recheck,
      viewer: state.viewer,
      ...(conversation === undefined ? {} : { conversation }),
      ...(ci === undefined ? {} : { ci }),
    },
    reviewDeps,
  )
  const fixed = (reviewed.recheck?.verdicts ?? []).filter(({ verdict }) => verdict === 'fixed')
  const { outcome } = reviewed
  if (outcome.status === 'skipped') {
    if (outcome.reason !== 'all-ignored') {
      deps.events.reviewed(reviewed, pullRequest)
      return { status: 'nothing', pullRequest, reviewed, reviewState: state }
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
      publication: await publish(input, deps, pullRequest, rendered, fixed, reviewed.language),
      reviewState: state,
    }
  }

  const fixedIds = new Set(fixed.map(({ threadId }) => threadId))
  const plan = planPublication(outcome.result.findings, state, fixedIds)
  const rendered = deps.render.review(outcome.result, plan, reviewed.language, ci?.summary)
  deps.events.reviewed(reviewed, pullRequest)
  return {
    status: 'reviewed',
    pullRequest,
    reviewed,
    plan,
    rendered,
    publication: await publish(input, deps, pullRequest, rendered, fixed, reviewed.language),
    ...(decision.wouldSkip === undefined ? {} : { wouldSkip: decision.wouldSkip }),
    reviewState: state,
  }
}

async function publish(
  input: ReviewAndPublishInput,
  deps: ReviewAndPublishDeps,
  pullRequest: PullRequest,
  rendered: RenderedReview,
  fixed: readonly RecheckVerdict[],
  language: string | undefined,
): Promise<PublicationResult> {
  if (input.dryRun) return { status: 'dry-run', wouldResolve: [...fixed] }
  if (!input.publish) return { status: 'not-published' }
  try {
    const head = (await deps.checkHead?.(pullRequest)) ?? 'current'
    if (head === 'closed-or-draft') return { status: 'closed-or-draft' }
    if (head !== 'current') return { status: 'superseded', headSha: head.superseded }
    deps.events.publishing()
    const resolved = await resolveFixed(deps, pullRequest.headSha, fixed, language)
    const created = await deps.createReview(pullRequest, rendered)
    return { status: 'published', url: created.url, resolved }
  } catch (error) {
    return { status: 'failed', error }
  }
}

async function resolveFixed(
  deps: ReviewAndPublishDeps,
  headSha: string,
  fixed: readonly RecheckVerdict[],
  language: string | undefined,
): Promise<ResolvedThreads> {
  let resolved = 0
  for (const { threadId, reason } of fixed) {
    const reply = deps.render.resolvedReply(headSha, reason, language)
    try {
      await deps.replyAndResolve(threadId, `${reply}\n\n${resolvedMarker(headSha)}`)
      resolved++
    } catch (error) {
      deps.events.warning(`Could not resolve a fixed comment: ${errorMessage(error)}`)
    }
  }
  return { resolved, failed: fixed.length - resolved, total: fixed.length }
}

async function readConversation(
  ref: PullRequestRef,
  state: PullRequestReviewState,
  pullRequest: PullRequest,
  deps: ReviewAndPublishDeps,
): Promise<Conversation> {
  let comments: PullComment[] = []
  try {
    comments = await deps.fetchPullComments(ref)
  } catch (error) {
    deps.events.warning(`Pull request comments were not read: ${errorMessage(error)}`)
  }
  return buildConversation({ state, comments, author: pullRequest.author })
}

async function threadsWithChanges(
  state: PullRequestReviewState,
  pullRequest: PullRequest,
  deps: ReviewAndPublishDeps,
): Promise<RecheckThread[]> {
  const items = threadsToRecheck(state, pullRequest.headSha)
  const comparisons = new Map<string, readonly ComparedFile[] | 'unavailable'>()
  for (const { reviewedSha } of items) {
    if (reviewedSha === null || comparisons.has(reviewedSha)) continue
    comparisons.set(
      reviewedSha,
      await deps.compare(pullRequest, reviewedSha).catch(() => 'unavailable' as const),
    )
  }
  return withChanges(items, comparisons satisfies Comparisons)
}
