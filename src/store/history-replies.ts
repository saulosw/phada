import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { ReplyKind } from '../review/types.js'
import { fromRow, insertStatement, REPLY_DUE_TABLE, REPLY_TABLE } from './history-columns.js'
import { transaction } from './history-feedback.js'

export type ReplySource = 'watch' | 'manual'

export interface ClassifiedReply {
  repo: string
  number: number
  threadId: string
  commentId: string
  author: string
  kind: ReplyKind
  answered: boolean
  answerId?: string
  answerUrl?: string
  resolved: boolean
  source: ReplySource
  observedAt: string
}

export interface ReplyDue {
  repo: string
  number: number
  since: string
  triedAt?: string
}

export interface ReplyFilter {
  repo?: string
  number?: number
  threadId?: string
}

export function recordReplies(db: DatabaseSync, replies: readonly ClassifiedReply[]): void {
  transaction(db, () => {
    for (const reply of replies) {
      const { sql, values } = insertStatement(REPLY_TABLE, reply)
      db.prepare(`${sql} on conflict (comment_id) do nothing`).run(...values)
    }
  })
}

export function classifiedComments(db: DatabaseSync, repo: string, number: number): Set<string> {
  const rows = db
    .prepare('select comment_id from thread_reply where repo = ? and number = ?')
    .all(repo.toLowerCase(), number)
  return new Set(rows.map((row) => String(row.comment_id)))
}

export function replies(db: DatabaseSync, filter: ReplyFilter): ClassifiedReply[] {
  const where: string[] = []
  const values: SQLInputValue[] = []
  if (filter.repo !== undefined) {
    where.push('repo = ?')
    values.push(filter.repo.toLowerCase())
  }
  if (filter.number !== undefined) {
    where.push('number = ?')
    values.push(filter.number)
  }
  if (filter.threadId !== undefined) {
    where.push('thread_id = ?')
    values.push(filter.threadId)
  }
  const clause = where.length === 0 ? '' : ` where ${where.join(' and ')}`
  return db
    .prepare(`select * from thread_reply${clause} order by id`)
    .all(...values)
    .map((row) => fromRow<ClassifiedReply>(row, REPLY_TABLE))
}

export function markRepliesDue(
  db: DatabaseSync,
  repo: string,
  numbers: readonly number[],
  since: string,
): void {
  transaction(db, () => {
    for (const number of numbers) {
      const { sql, values } = insertStatement(REPLY_DUE_TABLE, { repo, number, since })
      db.prepare(`${sql} on conflict (repo, number) do nothing`).run(...values)
    }
  })
}

export function repliesDue(db: DatabaseSync, repo: string): ReplyDue[] {
  return db
    .prepare('select * from reply_due where repo = ? order by since, number')
    .all(repo.toLowerCase())
    .map((row) => fromRow<ReplyDue>(row, REPLY_DUE_TABLE))
}

export function triedReplyDue(db: DatabaseSync, repo: string, number: number, at: string): void {
  db.prepare('update reply_due set tried_at = ? where repo = ? and number = ?').run(
    at,
    repo.toLowerCase(),
    number,
  )
}

export function clearReplyDue(db: DatabaseSync, repo: string, number: number): void {
  db.prepare('delete from reply_due where repo = ? and number = ?').run(repo.toLowerCase(), number)
}
