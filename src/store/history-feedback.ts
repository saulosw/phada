import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { SignalKind, ThreadFeedback } from '../publish/feedback.js'
import type { Severity } from '../review/types.js'
import {
  FEEDBACK_PULL_TABLE,
  FINDING_TABLE,
  fromRow,
  insertStatement,
  SIGNAL_TABLE,
  updateStatement,
  upsertStatement,
} from './history-columns.js'
import type { Statement } from './history-columns.js'

export type SignalSource = 'watch' | 'manual' | 'refresh'
export type PullState = 'open' | 'closed' | 'merged'

export interface PublishedFinding {
  repo: string
  number: number
  commitSha: string
  fingerprint: string
  file: string
  line: number
  title: string
  severity: Severity
  confidence: number
  rule?: string
  runId?: number
  publishedAt: string
}

export interface FeedbackObservation {
  repo: string
  number: number
  pullState: PullState
  observedAt: string
  source: SignalSource
  threads: readonly ThreadFeedback[]
}

export interface SignalRecord {
  kind: SignalKind
  source: SignalSource
  observedAt: string
  clearedAt?: string
}

export interface FindingRecord {
  id: number
  repo: string
  number: number
  commitSha?: string
  fingerprint: string
  file: string
  line?: number
  title: string
  severity?: Severity
  confidence?: number
  rule?: string
  runId?: number
  threadId?: string
  threadUrl?: string
  outdated: boolean
  publishedAt: string
  signals: SignalRecord[]
}

export interface FindingFilter {
  repo?: string
  number?: number
  since?: string
}

export interface DueFilter {
  repos?: readonly string[]
  repo?: string
  number?: number
}

export interface DuePull {
  repo: string
  number: number
}

type FindingRow = Omit<FindingRecord, 'signals'>

export function recordPublished(db: DatabaseSync, findings: readonly PublishedFinding[]): void {
  transaction(db, () => {
    for (const finding of findings) run(db, insertStatement(FINDING_TABLE, finding))
  })
}

export function observeFeedback(db: DatabaseSync, observation: FeedbackObservation): void {
  transaction(db, () => {
    for (const thread of observation.threads) {
      const findingId = findingOf(db, observation, thread)
      reconcileSignals(db, findingId, thread.signals, observation)
    }
    run(
      db,
      upsertStatement(FEEDBACK_PULL_TABLE, {
        repo: observation.repo,
        number: observation.number,
        observedAt: observation.observedAt,
        pullState: observation.pullState,
      }),
    )
  })
}

export function findings(db: DatabaseSync, filter: FindingFilter): FindingRecord[] {
  const { clause, values } = where([
    ['repo = ?', filter.repo?.toLowerCase()],
    ['number = ?', filter.number],
    ['published_at >= ?', filter.since],
  ])
  const signals = db.prepare('select * from signal where finding_id = ? order by observed_at, id')
  return db
    .prepare(`select * from finding${clause} order by repo, number, id`)
    .all(...values)
    .map((row) => {
      const finding = fromRow<FindingRow>(row, FINDING_TABLE)
      return {
        ...finding,
        outdated: finding.outdated ?? false,
        signals: signals.all(finding.id).map((signal) => {
          const { kind, source, observedAt, clearedAt } = fromRow<SignalRecord>(
            signal,
            SIGNAL_TABLE,
          )
          return { kind, source, observedAt, ...(clearedAt === undefined ? {} : { clearedAt }) }
        }),
      }
    })
}

export function feedbackDue(
  db: DatabaseSync,
  filter: DueFilter,
  before: string,
  limit?: number,
): DuePull[] {
  const repos = filter.repos?.map((repo) => repo.toLowerCase())
  const { clause, values } = where([
    [
      `(f.pull_state is null or f.pull_state = 'open' or exists (
        select 1 from watched_pull w where w.repo = p.repo and w.number = p.number
        and w.state = 'open'))`,
      undefined,
      true,
    ],
    ['(f.observed_at is null or f.observed_at < ?)', before],
    ['p.repo = ?', filter.repo?.toLowerCase()],
    ['p.number = ?', filter.number],
  ])
  const inRepos =
    repos === undefined ? '' : ` and p.repo in (${repos.map(() => '?').join(', ') || 'null'})`
  const sql = `select p.repo as repo, p.number as number from (
      select repo, number from finding
      union
      select repo, number from run where status = 'published' and findings > 0
    ) p left join feedback_pull f on f.repo = p.repo and f.number = p.number
    ${clause}${inRepos}
    order by f.observed_at is not null, f.observed_at, p.repo, p.number
    ${limit === undefined ? '' : 'limit ?'}`
  return db
    .prepare(sql)
    .all(...values, ...(repos ?? []), ...(limit === undefined ? [] : [limit]))
    .map((row) => ({ repo: String(row.repo), number: Number(row.number) }))
}

function findingOf(
  db: DatabaseSync,
  observation: FeedbackObservation,
  thread: ThreadFeedback,
): number {
  const seen = { line: thread.line ?? undefined, outdated: thread.outdated }
  const url = thread.url === '' ? {} : { threadUrl: thread.url }
  const known = db.prepare('select id from finding where thread_id = ?').get(thread.threadId)
  if (known !== undefined) {
    update(db, Number(known.id), { ...seen, ...url })
    return Number(known.id)
  }
  const published =
    thread.commitSha === null
      ? undefined
      : db
          .prepare(
            `select id from finding where thread_id is null and repo = ? and number = ?
             and commit_sha = ? and fingerprint = ? order by id limit 1`,
          )
          .get(
            observation.repo.toLowerCase(),
            observation.number,
            thread.commitSha,
            thread.fingerprint,
          )
  if (published !== undefined) {
    update(db, Number(published.id), { ...seen, ...url, threadId: thread.threadId })
    return Number(published.id)
  }
  const inserted = run(
    db,
    insertStatement(FINDING_TABLE, {
      repo: observation.repo,
      number: observation.number,
      ...(thread.commitSha === null ? {} : { commitSha: thread.commitSha }),
      fingerprint: thread.fingerprint,
      file: thread.file,
      ...seen,
      title: thread.title,
      severity: thread.severity,
      threadId: thread.threadId,
      ...url,
      publishedAt: observation.observedAt,
    }),
  )
  return Number(inserted.lastInsertRowid)
}

function reconcileSignals(
  db: DatabaseSync,
  findingId: number,
  kinds: readonly SignalKind[],
  observation: FeedbackObservation,
): void {
  const current = db
    .prepare('select id, kind from signal where finding_id = ? and cleared_at is null')
    .all(findingId)
  for (const kind of kinds) {
    if (current.some((row) => row.kind === kind)) continue
    run(
      db,
      insertStatement(SIGNAL_TABLE, {
        findingId,
        kind,
        source: observation.source,
        observedAt: observation.observedAt,
      }),
    )
  }
  for (const row of current) {
    if (kinds.includes(row.kind as SignalKind)) continue
    const statement = updateStatement(SIGNAL_TABLE, Number(row.id), {
      clearedAt: observation.observedAt,
    })
    if (statement !== undefined) run(db, statement)
  }
}

function update(db: DatabaseSync, id: number, changes: object): void {
  const defined = Object.entries(changes).filter(([, value]) => value !== undefined)
  const statement = updateStatement(FINDING_TABLE, id, Object.fromEntries(defined))
  if (statement !== undefined) run(db, statement)
}

function where(conditions: [string, SQLInputValue | undefined, true?][]): {
  clause: string
  values: SQLInputValue[]
} {
  const used = conditions.filter(([, value, always]) => always === true || value !== undefined)
  return {
    clause: used.length === 0 ? '' : ` where ${used.map(([sql]) => sql).join(' and ')}`,
    values: used.flatMap(([, value, always]) => (always === true ? [] : [value ?? null])),
  }
}

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('begin immediate')
  try {
    const result = work()
    db.exec('commit')
    return result
  } catch (error) {
    db.exec('rollback')
    throw error
  }
}

function run(db: DatabaseSync, { sql, values }: Statement) {
  return db.prepare(sql).run(...values)
}
