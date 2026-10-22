import type { ComparedFile } from '../github/compare-commits.js'
import type { PullRequestReviewState, ReviewThread } from '../github/pull-request-reviews.js'
import type { RecheckThread } from '../review/types.js'
import { findingTitle, parseReviewMarker } from './markers.js'
import { openPhadaThreads, repliedAsResolved } from './phada-state.js'

export interface ThreadToRecheck {
  thread: ReviewThread
  reviewedSha: string | null
}

export type Comparisons = ReadonlyMap<string, readonly ComparedFile[] | 'unavailable'>

export function threadsToRecheck(
  state: PullRequestReviewState,
  headSha: string,
): ThreadToRecheck[] {
  return openPhadaThreads(state).flatMap((thread) => {
    if (repliedAsResolved(state, thread)) return []
    const reviewedSha = reviewedShaOf(state, thread)
    return reviewedSha === headSha ? [] : [{ thread, reviewedSha }]
  })
}

export function withChanges(
  items: readonly ThreadToRecheck[],
  comparisons: Comparisons,
): RecheckThread[] {
  return items.map(({ thread, reviewedSha }) => {
    const files = reviewedSha === null ? undefined : comparisons.get(reviewedSha)
    const known = files !== undefined && files !== 'unavailable'
    const file = known
      ? files.find((item) => item.path === thread.path || item.previousPath === thread.path)
      : undefined
    return {
      id: thread.id,
      file: thread.path,
      line: thread.line,
      title: findingTitle(thread.body) ?? thread.path,
      body: thread.body,
      ...(file?.patch === undefined ? {} : { patch: file.patch }),
      changed: !known || file !== undefined,
    }
  })
}

function reviewedShaOf(state: PullRequestReviewState, thread: ReviewThread): string | null {
  const review = state.reviews.find((item) => item.id === thread.reviewId)
  if (review === undefined) return null
  return review.commitSha ?? parseReviewMarker(review.body)?.sha ?? null
}
