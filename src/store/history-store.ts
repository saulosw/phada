import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { HISTORY_MIGRATIONS } from './history-migrations.js'
import type { HistoryMigration } from './history-migrations.js'
import {
  fromRow,
  insertStatement,
  JOB_TABLE,
  PULL_TABLE,
  REPO_TABLE,
  REQUEST_TABLE,
  RUN_TABLE,
  upsertStatement,
  updateStatement,
} from './history-columns.js'
import type { Statement } from './history-columns.js'
import { isNotADatabase } from './index-store.js'
import {
  feedbackDue,
  findings,
  observeFeedback,
  recordPublished,
  transaction,
} from './history-feedback.js'
import type {
  DueFilter,
  DuePull,
  FeedbackObservation,
  FindingFilter,
  FindingRecord,
  PublishedFinding,
} from './history-feedback.js'
import type {
  FailureKind,
  JobRecord,
  JobStatus,
  PauseState,
  PullRecord,
  RequestRecord,
  RequestSource,
} from '../watch/types.js'

export type {
  DueFilter,
  DuePull,
  FeedbackObservation,
  FindingFilter,
  FindingRecord,
  PublishedFinding,
  PullState,
  SignalRecord,
  SignalSource,
} from './history-feedback.js'

export type RunStatus =
  'published' | 'dry-run' | 'not-published' | 'superseded' | 'skipped' | 'nothing' | 'failed'

export interface RepoRecord {
  repo: string
  pullsEtag?: string
  baselineAt?: string
  checkedAt?: string
  branchEtag?: string
  branchCheckedAt?: string
  indexedSha?: string
}

export interface RunRecord {
  id?: number
  jobId?: number
  source: 'watch' | 'manual'
  repo: string
  number: number
  headSha: string
  startedAt: string
  finishedAt: string
  status: RunStatus
  aiCalled: boolean
  provider?: string
  model?: string
  score?: number
  findings?: number
  url?: string
  reason?: string
  errorKind?: FailureKind
  error?: string
  resultJson?: string
}

export interface StatusJob extends JobRecord {
  sources?: RequestSource[]
}

export interface HistoryStatus {
  repos: RepoRecord[]
  queued: StatusJob[]
  running: StatusJob[]
  failed: JobRecord[]
  lastRuns: RunRecord[]
  pause?: PauseState
}

export interface HistoryFilter {
  repo?: string
  number?: number
  since?: string
  limit?: number
}

export interface PruneCounts {
  runs: number
  findings: number
  jobs: number
  vacuumed: boolean
}

export interface HistoryStore {
  readonly path: string
  repo(name: string): RepoRecord | undefined
  saveRepo(record: RepoRecord): void
  pulls(repo: string): PullRecord[]
  savePull(record: PullRecord): void
  jobs(filter: { repo?: string; status?: readonly JobStatus[] }): JobRecord[]
  addJob(job: Omit<JobRecord, 'id'>): number
  updateJob(id: number, changes: Partial<Omit<JobRecord, 'id'>>): void
  recoverRunning(maxAttempts: number, now: string): JobRecord[]
  jobsCreatedSince(iso: string): string[]
  addRequest(request: Omit<RequestRecord, 'id'>): number
  requests(jobIds: readonly number[]): RequestRecord[]
  transaction<T>(work: () => T): T
  addRun(run: RunRecord): number
  watchRunsSince(iso: string): string[]
  pause(): PauseState | undefined
  setPause(state: PauseState | undefined): void
  status(): HistoryStatus
  recordPublished(findings: readonly PublishedFinding[]): void
  observeFeedback(observation: FeedbackObservation): void
  findings(filter: FindingFilter): FindingRecord[]
  feedbackDue(filter: DueFilter, before: string, limit?: number): DuePull[]
  runs(filter: HistoryFilter): { runs: RunRecord[]; total: number }
  prune(before: string): PruneCounts
  close(): void
}

export class HistoryStoreError extends Error {
  override readonly name: string = 'HistoryStoreError'
}

export class HistoryVersionError extends HistoryStoreError {
  override readonly name = 'HistoryVersionError'
  readonly found: number
  readonly known: number

  constructor(path: string, found: number, known: number) {
    super(
      `${path} was written by a newer Phada (history version ${found}, this one knows ${known}); update Phada`,
    )
    this.found = found
    this.known = known
  }
}

type Sqlite = typeof import('node:sqlite')

export interface OpenHistoryStoreOptions {
  loadSqlite?: () => Promise<Sqlite>
  migrations?: readonly HistoryMigration[]
}

const RECENT_FAILURES = 20
const PAUSE_KEY = 'pause'

export async function openHistoryStore(
  path: string,
  options: OpenHistoryStoreOptions = {},
): Promise<HistoryStore> {
  let sqlite: Sqlite
  try {
    sqlite = await (options.loadSqlite ?? (() => import('node:sqlite')))()
  } catch {
    throw new HistoryStoreError('The review history needs Node.js 22.13 or newer')
  }
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new HistoryStoreError(`Cannot write ${path}: ${(error as Error).message}`)
  }
  let db: DatabaseSync
  try {
    db = new sqlite.DatabaseSync(path)
  } catch (error) {
    throw new HistoryStoreError(`Cannot open ${path}: ${(error as Error).message}`)
  }
  try {
    db.exec('pragma busy_timeout = 5000')
    db.exec('pragma journal_mode = wal')
    db.exec('pragma foreign_keys = on')
    migrate(db, path, options.migrations ?? HISTORY_MIGRATIONS)
  } catch (error) {
    db.close()
    if (error instanceof HistoryStoreError) throw error
    const message = (error as Error).message
    throw new HistoryStoreError(
      isNotADatabase(error)
        ? `${path} is not a Phada history file; move it away to start a new one`
        : `Cannot open ${path}: ${message}`,
    )
  }
  return new SqliteHistoryStore(db, path)
}

function migrate(db: DatabaseSync, path: string, migrations: readonly HistoryMigration[]): void {
  const known = migrations.at(-1)?.version ?? 0
  const current = Number(db.prepare('pragma user_version').get()?.user_version ?? 0)
  if (current > known) throw new HistoryVersionError(path, current, known)
  for (const migration of migrations) {
    if (migration.version <= current) continue
    db.exec('begin immediate')
    try {
      db.exec(migration.sql)
      db.exec(`pragma user_version = ${migration.version}`)
      db.exec('commit')
    } catch (error) {
      db.exec('rollback')
      throw new HistoryStoreError(
        `Cannot update ${path} to history version ${migration.version}: ${(error as Error).message}`,
      )
    }
  }
}

class SqliteHistoryStore implements HistoryStore {
  readonly path: string
  readonly #db: DatabaseSync

  constructor(db: DatabaseSync, path: string) {
    this.#db = db
    this.path = path
  }

  repo(name: string): RepoRecord | undefined {
    const row = this.#db
      .prepare('select * from watched_repo where repo = ?')
      .get(name.toLowerCase())
    return row === undefined ? undefined : fromRow<RepoRecord>(row, REPO_TABLE)
  }

  saveRepo(record: RepoRecord): void {
    this.#run(upsertStatement(REPO_TABLE, record))
  }

  pulls(repo: string): PullRecord[] {
    return this.#db
      .prepare('select * from watched_pull where repo = ? order by number')
      .all(repo.toLowerCase())
      .map((row) => fromRow<PullRecord>(row, PULL_TABLE))
  }

  savePull(record: PullRecord): void {
    this.#run(upsertStatement(PULL_TABLE, record))
  }

  jobs(filter: { repo?: string; status?: readonly JobStatus[] }): JobRecord[] {
    const where: string[] = []
    const values: SQLInputValue[] = []
    if (filter.repo !== undefined) {
      where.push('repo = ?')
      values.push(filter.repo.toLowerCase())
    }
    if (filter.status !== undefined) {
      where.push(`status in (${filter.status.map(() => '?').join(', ')})`)
      values.push(...filter.status)
    }
    const clause = where.length === 0 ? '' : ` where ${where.join(' and ')}`
    return this.#db
      .prepare(`select * from job${clause} order by not_before, id`)
      .all(...values)
      .map((row) => fromRow<JobRecord>(row, JOB_TABLE))
  }

  addJob(job: Omit<JobRecord, 'id'>): number {
    return Number(this.#run(insertStatement(JOB_TABLE, job)).lastInsertRowid)
  }

  updateJob(id: number, changes: Partial<Omit<JobRecord, 'id'>>): void {
    const statement = updateStatement(JOB_TABLE, id, changes)
    if (statement !== undefined) this.#run(statement)
  }

  recoverRunning(maxAttempts: number, now: string): JobRecord[] {
    const running = this.jobs({ status: ['running'] })
    for (const job of running) {
      const attempts = job.attempts + 1
      this.updateJob(
        job.id,
        attempts >= maxAttempts
          ? {
              status: 'failed',
              attempts,
              errorKind: 'transient',
              error: 'interrupted',
              finishedAt: now,
            }
          : { status: 'queued', attempts },
      )
    }
    return running
  }

  jobsCreatedSince(iso: string): string[] {
    return this.#db
      .prepare('select created_at from job where created_at > ? order by created_at')
      .all(iso)
      .map((row) => String(row.created_at))
  }

  addRequest(request: Omit<RequestRecord, 'id'>): number {
    return Number(this.#run(insertStatement(REQUEST_TABLE, request)).lastInsertRowid)
  }

  requests(jobIds: readonly number[]): RequestRecord[] {
    if (jobIds.length === 0) return []
    return this.#db
      .prepare(
        `select * from review_request where job_id in (${jobIds.map(() => '?').join(', ')}) order by id`,
      )
      .all(...jobIds)
      .map((row) => fromRow<RequestRecord>(row, REQUEST_TABLE))
  }

  transaction<T>(work: () => T): T {
    return transaction(this.#db, work)
  }

  addRun(run: RunRecord): number {
    return Number(this.#run(insertStatement(RUN_TABLE, run)).lastInsertRowid)
  }

  watchRunsSince(iso: string): string[] {
    return this.#db
      .prepare(
        "select started_at from run where source = 'watch' and ai_called = 1 and started_at > ? order by started_at",
      )
      .all(iso)
      .map((row) => String(row.started_at))
  }

  pause(): PauseState | undefined {
    const row = this.#db.prepare('select value from watch_state where key = ?').get(PAUSE_KEY)
    return row === undefined ? undefined : (JSON.parse(String(row.value)) as PauseState)
  }

  setPause(state: PauseState | undefined): void {
    if (state === undefined) {
      this.#db.prepare('delete from watch_state where key = ?').run(PAUSE_KEY)
      return
    }
    this.#db
      .prepare(
        'insert into watch_state (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
      )
      .run(PAUSE_KEY, JSON.stringify(state))
  }

  status(): HistoryStatus {
    const pause = this.pause()
    const failed = this.#db
      .prepare(
        "select * from job where status = 'failed' order by finished_at desc, id desc limit ?",
      )
      .all(RECENT_FAILURES)
      .map((row) => fromRow<JobRecord>(row, JOB_TABLE))
    const lastRuns = this.#db
      .prepare(
        'select * from run where id in (select max(id) from run group by repo) order by repo',
      )
      .all()
      .map((row) => {
        const { resultJson: _json, ...run } = fromRow<RunRecord>(row, RUN_TABLE)
        return run
      })
    return {
      repos: this.#db
        .prepare('select * from watched_repo order by repo')
        .all()
        .map((row) => fromRow<RepoRecord>(row, REPO_TABLE)),
      queued: this.#withSources(this.jobs({ status: ['queued'] })),
      running: this.#withSources(this.jobs({ status: ['running'] })),
      failed,
      lastRuns,
      ...(pause === undefined ? {} : { pause }),
    }
  }

  recordPublished(published: readonly PublishedFinding[]): void {
    recordPublished(this.#db, published)
  }

  observeFeedback(observation: FeedbackObservation): void {
    observeFeedback(this.#db, observation)
  }

  findings(filter: FindingFilter): FindingRecord[] {
    return findings(this.#db, filter)
  }

  feedbackDue(filter: DueFilter, before: string, limit?: number): DuePull[] {
    return feedbackDue(this.#db, filter, before, limit)
  }

  runs(filter: HistoryFilter): { runs: RunRecord[]; total: number } {
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
    if (filter.since !== undefined) {
      where.push('started_at >= ?')
      values.push(filter.since)
    }
    const clause = where.length === 0 ? '' : ` where ${where.join(' and ')}`
    const total = Number(
      this.#db.prepare(`select count(*) as total from run${clause}`).get(...values)?.total ?? 0,
    )
    const limit = filter.limit === undefined ? '' : ' limit ?'
    const runs = this.#db
      .prepare(`select * from run${clause} order by started_at desc, id desc${limit}`)
      .all(...values, ...(filter.limit === undefined ? [] : [filter.limit]))
      .map((row) => {
        const { resultJson: _json, ...run } = fromRow<RunRecord>(row, RUN_TABLE)
        return run
      })
    return { runs, total }
  }

  prune(before: string): PruneCounts {
    const counts = transaction(this.#db, () => {
      const runs = this.#changes('delete from run where started_at < ?', before)
      const findings = this.#changes('delete from finding where published_at < ?', before)
      const jobs = this.#changes(
        `delete from job where status in ('done', 'failed', 'skipped', 'superseded')
         and finished_at < ? and not exists (select 1 from run where run.job_id = job.id)
         and not exists (
           select 1 from watched_pull w where w.repo = job.repo and w.number = job.number
           and w.head_sha = job.head_sha and w.state = 'open')`,
        before,
      )
      this.#db
        .prepare(
          `delete from feedback_pull where not exists (
             select 1 from finding where finding.repo = feedback_pull.repo
             and finding.number = feedback_pull.number)
           and not exists (
             select 1 from run where run.repo = feedback_pull.repo
             and run.number = feedback_pull.number)`,
        )
        .run()
      return { runs, findings, jobs }
    })
    try {
      this.#db.exec('vacuum')
      return { ...counts, vacuumed: true }
    } catch {
      return { ...counts, vacuumed: false }
    }
  }

  close(): void {
    this.#db.close()
  }

  #withSources(jobs: readonly JobRecord[]): StatusJob[] {
    const requests = this.requests(jobs.map(({ id }) => id))
    return jobs.map((job) => {
      const sources = requests.filter(({ jobId }) => jobId === job.id).map(({ source }) => source)
      return sources.length === 0 ? job : { ...job, sources }
    })
  }

  #changes(sql: string, ...values: SQLInputValue[]): number {
    return Number(this.#db.prepare(sql).run(...values).changes)
  }

  #run({ sql, values }: Statement) {
    return this.#db.prepare(sql).run(...values)
  }
}
