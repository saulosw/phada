import type { ReviewComment } from '../github/review-comments.js'

export interface ReplyCursor {
  baselineAt: string
  lastId?: number
  open: ReadonlySet<number>
}

export interface ReplyScan {
  numbers: number[]
  lastId?: number
  since?: string
}

export function replyScan(comments: readonly ReviewComment[], cursor: ReplyCursor): ReplyScan {
  const fresh = comments
    .filter(({ id }) => cursor.lastId === undefined || id > cursor.lastId)
    .sort((first, second) => first.id - second.id)
  const newest = fresh.at(-1)
  if (newest === undefined) {
    return { numbers: [], ...(cursor.lastId === undefined ? {} : { lastId: cursor.lastId }) }
  }
  const numbers = fresh
    .filter(
      (comment) =>
        comment.inReplyTo !== undefined &&
        !comment.authorIsBot &&
        cursor.open.has(comment.number) &&
        Date.parse(comment.createdAt) >= Date.parse(cursor.baselineAt),
    )
    .map(({ number }) => number)
  return { numbers: [...new Set(numbers)], lastId: newest.id, since: newest.createdAt }
}
