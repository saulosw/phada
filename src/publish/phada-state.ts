import type { PullRequestReviewState, ReviewThread } from '../github/pull-request-reviews.js'
import { hasFindingMarker, parseReviewMarker } from './markers.js'
import type { ReviewMarker } from './markers.js'

export function phadaReviewsAt(state: PullRequestReviewState, sha: string): ReviewMarker[] {
  return state.reviews.flatMap((review) => {
    if (!isViewer(state, review.author)) return []
    const marker = parseReviewMarker(review.body)
    return marker?.sha === sha ? [marker] : []
  })
}

export function openPhadaThreads(state: PullRequestReviewState): ReviewThread[] {
  return state.threads.filter(
    (thread) =>
      !thread.isResolved && isViewer(state, thread.author) && hasFindingMarker(thread.body),
  )
}

function isViewer(state: PullRequestReviewState, author: string): boolean {
  return author !== '' && author === state.viewer
}
