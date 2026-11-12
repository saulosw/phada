import type { ReviewComment } from '../github/review-comments.js'
import { advanceCursor } from './comment-cursor.js'
import type { CommentCursor, CursorMove } from './comment-cursor.js'

export interface ReplyCursor extends CommentCursor {
  open: ReadonlySet<number>
}

export interface ReplyScan extends CursorMove {
  numbers: number[]
}

export function replyScan(comments: readonly ReviewComment[], cursor: ReplyCursor): ReplyScan {
  const { fresh, ...moved } = advanceCursor(comments, cursor)
  const numbers = fresh
    .filter(
      (comment) =>
        comment.inReplyTo !== undefined && !comment.authorIsBot && cursor.open.has(comment.number),
    )
    .map(({ number }) => number)
  return { numbers: [...new Set(numbers)], ...moved }
}
