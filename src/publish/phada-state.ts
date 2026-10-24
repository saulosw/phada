import type { PullRequestReviewState, ReviewThread } from '../github/pull-request-reviews.js'
import { hasFindingMarker, hasResolvedMarker, parseReviewMarker } from './markers.js'
import type { ReviewMarker } from './markers.js'

export function latestPhadaReview(state: PullRequestReviewState): ReviewMarker | undefined {
  return state.reviews
    .flatMap((review) => {
      if (!isViewer(state, review.author)) return []
      const marker = parseReviewMarker(review.body)
      return marker === undefined ? [] : [marker]
    })
    .at(-1)
}

export function phadaReviewsAt(state: PullRequestReviewState, sha: string): ReviewMarker[] {
  return state.reviews.flatMap((review) => {
    if (!isViewer(state, review.author)) return []
    const marker = parseReviewMarker(review.body)
    return marker?.sha === sha ? [marker] : []
  })
}

export function phadaReviewUrlAt(state: PullRequestReviewState, sha: string): string | undefined {
  return state.reviews
    .filter(
      (review) =>
        isViewer(state, review.author) &&
        parseReviewMarker(review.body)?.sha === sha &&
        review.url !== undefined,
    )
    .at(-1)?.url
}

export function phadaThreads(state: PullRequestReviewState): ReviewThread[] {
  return state.threads.filter(
    (thread) => isViewer(state, thread.author) && hasFindingMarker(thread.body),
  )
}

export function openPhadaThreads(state: PullRequestReviewState): ReviewThread[] {
  return phadaThreads(state).filter((thread) => !thread.isResolved)
}

export function resolvedByPhada(state: PullRequestReviewState, thread: ReviewThread): boolean {
  return thread.isResolved && repliedAsResolved(state, thread)
}

export function repliedAsResolved(state: PullRequestReviewState, thread: ReviewThread): boolean {
  return thread.replies.some(
    (reply) => isViewer(state, reply.author) && hasResolvedMarker(reply.body),
  )
}

function isViewer(state: PullRequestReviewState, author: string): boolean {
  return author !== '' && author === state.viewer
}

export function reviewedShaOf(state: PullRequestReviewState, thread: ReviewThread): string | null {
  const review = state.reviews.find((item) => item.id === thread.reviewId)
  if (review === undefined) return null
  return review.commitSha ?? parseReviewMarker(review.body)?.sha ?? null
}
