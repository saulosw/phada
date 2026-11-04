import type {
  PullComment,
  PullRequestReviewState,
  ReviewThread,
} from '../github/pull-request-reviews.js'
import { writtenLine } from './written-line.js'

export function reviewStateAt(state: PullRequestReviewState, at: string): PullRequestReviewState {
  const createdBy = createdUpTo(at)
  return {
    ...state,
    reviews: state.reviews.filter(createdBy),
    threads: state.threads.filter(createdBy).map((thread) => threadAt(thread, createdBy)),
  }
}

export function commentsAt(comments: readonly PullComment[], at: string): PullComment[] {
  return comments.filter(createdUpTo(at))
}

function threadAt(
  thread: ReviewThread,
  createdBy: (item: { createdAt?: string }) => boolean,
): ReviewThread {
  const replies = thread.replies.filter(createdBy)
  const others = thread.replies.filter(({ id }) => id !== thread.commentId)
  const keptOthers = others.filter(createdBy)
  const total = thread.comments ?? 1
  return {
    ...thread,
    line: writtenLine(thread),
    isResolved: false,
    isOutdated: false,
    replies,
    comments: keptOthers.length === 0 ? 1 : total - (thread.replies.length - replies.length),
  }
}

function createdUpTo(at: string): (item: { createdAt?: string }) => boolean {
  const moment = Date.parse(at)
  return ({ createdAt }) => createdAt !== undefined && Date.parse(createdAt) <= moment
}
