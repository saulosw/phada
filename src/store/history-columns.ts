import type { SQLInputValue } from 'node:sqlite'

export interface HistoryTable {
  name: string
  keys: readonly string[]
  columns: Readonly<Record<string, string>>
}

export interface Statement {
  sql: string
  values: SQLInputValue[]
}

type Row = Record<string, SQLInputValue>

export const REPO_TABLE: HistoryTable = {
  name: 'watched_repo',
  keys: ['repo'],
  columns: {
    repo: 'repo',
    pullsEtag: 'pulls_etag',
    baselineAt: 'baseline_at',
    checkedAt: 'checked_at',
    branchEtag: 'branch_etag',
    branchCheckedAt: 'branch_checked_at',
    indexedSha: 'indexed_sha',
  },
}

export const PULL_TABLE: HistoryTable = {
  name: 'watched_pull',
  keys: ['repo', 'number'],
  columns: {
    repo: 'repo',
    number: 'number',
    headSha: 'head_sha',
    headSeenAt: 'head_seen_at',
    baselineSha: 'baseline_sha',
    eligible: 'eligible',
    state: 'state',
  },
}

export const JOB_TABLE: HistoryTable = {
  name: 'job',
  keys: ['id'],
  columns: {
    id: 'id',
    repo: 'repo',
    number: 'number',
    headSha: 'head_sha',
    status: 'status',
    attempts: 'attempts',
    notBefore: 'not_before',
    reason: 'reason',
    errorKind: 'error_kind',
    error: 'error',
    createdAt: 'created_at',
    startedAt: 'started_at',
    finishedAt: 'finished_at',
  },
}

export const RUN_TABLE: HistoryTable = {
  name: 'run',
  keys: ['id'],
  columns: {
    id: 'id',
    jobId: 'job_id',
    source: 'source',
    repo: 'repo',
    number: 'number',
    headSha: 'head_sha',
    startedAt: 'started_at',
    finishedAt: 'finished_at',
    status: 'status',
    aiCalled: 'ai_called',
    provider: 'provider',
    model: 'model',
    score: 'score',
    findings: 'findings',
    url: 'url',
    reason: 'reason',
    errorKind: 'error_kind',
    error: 'error',
    resultJson: 'result_json',
  },
}

const NUMBERS = new Set(['id', 'number', 'attempts', 'jobId', 'score', 'findings'])
const BOOLEANS = new Set(['eligible', 'aiCalled'])
const LOWERCASE = new Set(['repo'])

export class UnknownHistoryFieldError extends Error {
  override readonly name = 'UnknownHistoryFieldError'
}

export function columnOf(table: HistoryTable, key: string): string {
  const column = table.columns[key]
  if (column === undefined) throw new UnknownHistoryFieldError(`Unknown history field ${key}`)
  return column
}

export function insertStatement(table: HistoryTable, record: object): Statement {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined)
  const names = entries.map(([key]) => columnOf(table, key))
  return {
    sql: `insert into ${table.name} (${names.join(', ')}) values (${names.map(() => '?').join(', ')})`,
    values: entries.map(([key, value]) => toColumn(key, value)),
  }
}

export function upsertStatement(table: HistoryTable, record: object): Statement {
  const fields = Object.keys(table.columns)
  const names = fields.map((key) => columnOf(table, key))
  const updates = fields
    .filter((key) => !table.keys.includes(key))
    .map((key) => `${columnOf(table, key)} = excluded.${columnOf(table, key)}`)
  const conflict = table.keys.map((key) => columnOf(table, key)).join(', ')
  return {
    sql: `insert into ${table.name} (${names.join(', ')}) values (${names.map(() => '?').join(', ')}) on conflict (${conflict}) do update set ${updates.join(', ')}`,
    values: fields.map((key) => toColumn(key, (record as Record<string, unknown>)[key])),
  }
}

export function updateStatement(
  table: HistoryTable,
  id: number,
  changes: object,
): Statement | undefined {
  const entries = Object.entries(changes)
  if (entries.length === 0) return undefined
  return {
    sql: `update ${table.name} set ${entries.map(([key]) => `${columnOf(table, key)} = ?`).join(', ')} where id = ?`,
    values: [...entries.map(([key, value]) => toColumn(key, value)), id],
  }
}

export function fromRow<T>(row: Row, table: HistoryTable): T {
  const record: Record<string, unknown> = {}
  for (const [key, column] of Object.entries(table.columns)) {
    const value = row[column]
    if (value === null || value === undefined) continue
    if (BOOLEANS.has(key)) record[key] = Number(value) === 1
    else if (NUMBERS.has(key)) record[key] = Number(value)
    else record[key] = String(value)
  }
  return record as T
}

function toColumn(key: string, value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null
  if (BOOLEANS.has(key)) return value === true ? 1 : 0
  if (LOWERCASE.has(key)) return String(value).toLowerCase()
  if (typeof value === 'number' || typeof value === 'string') return value
  return String(value)
}
