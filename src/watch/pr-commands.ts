import type { IssueComment } from '../github/issue-comments.js'
import { advanceCursor } from './comment-cursor.js'
import type { CommentCursor, CursorMove } from './comment-cursor.js'
import { TRUSTED_ASSOCIATIONS } from './filters.js'

const COMMAND = /^\/phada\s+review$/i

export interface PrCommand {
  number: number
  commentId: number
  url: string
  author: string
}

export interface CommandScan extends CursorMove {
  commands: PrCommand[]
}

export function prCommands(comments: readonly IssueComment[], cursor: CommentCursor): CommandScan {
  const { fresh, ...moved } = advanceCursor(comments, cursor)
  const commands = fresh
    .filter(
      (comment) =>
        comment.pullRequest &&
        !comment.authorIsBot &&
        TRUSTED_ASSOCIATIONS.has(comment.association) &&
        COMMAND.test(firstLine(comment.body)),
    )
    .map(({ number, id, url, author }) => ({ number, commentId: id, url, author }))
  return { commands, ...moved }
}

function firstLine(body: string): string {
  return (body.split('\n').find((line) => line.trim() !== '') ?? '').trim()
}
