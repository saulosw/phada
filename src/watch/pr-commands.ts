import type { IssueComment } from '../github/issue-comments.js'
import { TRUSTED_ASSOCIATIONS } from './filters.js'

const COMMAND = /^\/phada\s+review$/i

export interface PrCommand {
  number: number
  commentId: number
  url: string
  author: string
}

export interface CommandCursor {
  baselineAt: string
  lastId?: number
}

export interface CommandScan {
  commands: PrCommand[]
  lastId?: number
  since?: string
}

export function prCommands(comments: readonly IssueComment[], cursor: CommandCursor): CommandScan {
  const fresh = comments
    .filter(({ id }) => cursor.lastId === undefined || id > cursor.lastId)
    .sort((first, second) => first.id - second.id)
  const newest = fresh.at(-1)
  if (newest === undefined) {
    return { commands: [], ...(cursor.lastId === undefined ? {} : { lastId: cursor.lastId }) }
  }
  const commands = fresh
    .filter(
      (comment) =>
        comment.pullRequest &&
        !comment.authorIsBot &&
        TRUSTED_ASSOCIATIONS.has(comment.association) &&
        Date.parse(comment.createdAt) >= Date.parse(cursor.baselineAt) &&
        COMMAND.test(firstLine(comment.body)),
    )
    .map(({ number, id, url, author }) => ({ number, commentId: id, url, author }))
  return { commands, lastId: newest.id, since: newest.createdAt }
}

function firstLine(body: string): string {
  return (body.split('\n').find((line) => line.trim() !== '') ?? '').trim()
}
