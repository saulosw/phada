export interface CommentCursor {
  baselineAt: string
  lastId?: number
}

export interface CursorMove {
  lastId?: number
  since?: string
}

export function advanceCursor<C extends { id: number; createdAt: string }>(
  comments: readonly C[],
  cursor: CommentCursor,
): CursorMove & { fresh: C[] } {
  const unread = comments
    .filter(({ id }) => cursor.lastId === undefined || id > cursor.lastId)
    .sort((first, second) => first.id - second.id)
  const newest = unread.at(-1)
  if (newest === undefined) {
    return { fresh: [], ...(cursor.lastId === undefined ? {} : { lastId: cursor.lastId }) }
  }
  const fresh = unread.filter(
    ({ createdAt }) => Date.parse(createdAt) >= Date.parse(cursor.baselineAt),
  )
  return { fresh, lastId: newest.id, since: newest.createdAt }
}
