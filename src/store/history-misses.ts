import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { Miss } from '../publish/misses.js'
import {
  columnOf,
  fromRow,
  insertStatement,
  MISS_REPLAY_TABLE,
  MISS_TABLE,
  RUN_TABLE,
  upsertStatement,
} from './history-columns.js'
import type { DuePull } from './history-feedback.js'
import { transaction } from './history-feedback.js'
import type { RunRecord } from './history-store.js'

export type MissState = 'open' | 'dismissed'

export interface MissRecord extends Miss {
  id: number
  state: MissState
  harvestedAt: string
}

export type MissOutcome = 'caught' | 'missed'

export interface MissReplayRecord {
  missId: number
  version: string
  runId?: number
  outcome: MissOutcome
  replayedAt: string
}

export interface MissFilter {
  repo?: string
  number?: number
  state?: MissState
  limit?: number
}

const KEPT_ON_HARVEST = new Set(['key', 'state', 'harvestedAt'])

export function recordMisses(
  db: DatabaseSync,
  misses: readonly Miss[],
  harvestedAt: string,
): number {
  const known = db.prepare('select 1 from miss where key = ?')
  return transaction(db, () => {
    let added = 0
    for (const miss of misses) {
      if (known.get(miss.key) === undefined) added++
      const { sql, values } = insertStatement(MISS_TABLE, { ...miss, harvestedAt })
      const updates = Object.keys(MISS_TABLE.columns)
        .filter((key) => key !== 'id' && !KEPT_ON_HARVEST.has(key))
        .map((key) => `${columnOf(MISS_TABLE, key)} = excluded.${columnOf(MISS_TABLE, key)}`)
      db.prepare(`${sql} on conflict (key) do update set ${updates.join(', ')}`).run(...values)
    }
    return added
  })
}

export function misses(
  db: DatabaseSync,
  filter: MissFilter,
): { misses: MissRecord[]; total: number } {
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
  if (filter.state !== undefined) {
    where.push('state = ?')
    values.push(filter.state)
  }
  const clause = where.length === 0 ? '' : ` where ${where.join(' and ')}`
  const total = Number(
    db.prepare(`select count(*) as total from miss${clause}`).get(...values)?.total ?? 0,
  )
  const limit = filter.limit === undefined ? '' : ' limit ?'
  const rows = db
    .prepare(`select * from miss${clause} order by created_at desc, id desc${limit}`)
    .all(...values, ...(filter.limit === undefined ? [] : [filter.limit]))
  return { misses: rows.map((row) => fromRow<MissRecord>(row, MISS_TABLE)), total }
}

export function dismissMiss(db: DatabaseSync, id: number): boolean {
  return Number(db.prepare("update miss set state = 'dismissed' where id = ?").run(id).changes) > 0
}

export function recordMissReplays(db: DatabaseSync, replays: readonly MissReplayRecord[]): void {
  transaction(db, () => {
    for (const replay of replays) {
      const { sql, values } = upsertStatement(MISS_REPLAY_TABLE, replay)
      db.prepare(sql).run(...values)
    }
  })
}

export function missReplays(db: DatabaseSync, missIds: readonly number[]): MissReplayRecord[] {
  if (missIds.length === 0) return []
  return db
    .prepare(
      `select * from miss_replay where miss_id in (${missIds.map(() => '?').join(', ')})
       order by replayed_at, miss_id, version`,
    )
    .all(...missIds)
    .map((row) => fromRow<MissReplayRecord>(row, MISS_REPLAY_TABLE))
}

export interface AiRunFilter {
  replays?: boolean
}

export function aiRuns(db: DatabaseSync, pull: DuePull, filter: AiRunFilter = {}): RunRecord[] {
  const sources = filter.replays === true ? "'watch', 'manual', 'replay'" : "'watch', 'manual'"
  return db
    .prepare(
      `select * from run where repo = ? and number = ? and ai_called = 1
       and source in (${sources}) order by finished_at, id`,
    )
    .all(pull.repo.toLowerCase(), pull.number)
    .map((row) => fromRow<RunRecord>(row, RUN_TABLE))
}
