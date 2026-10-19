import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { HISTORY_MIGRATIONS } from './history-migrations.js'
import type { HistoryMigration } from './history-migrations.js'
import { isNotADatabase } from './index-store.js'

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'superseded'
export type RunStatus =
  'published' | 'dry-run' | 'not-published' | 'superseded' | 'skipped' | 'nothing' | 'failed'
export type FailureKind = 'transient' | 'usage-limit' | 'rate-limit' | 'definitive' | 'fatal'

export interface RepoRecord {
  repo: string
  pullsEtag?: string
  baselineAt?: string
  checkedAt?: string
  defaultBranch?: string
  branchEtag?: string
  branchCheckedAt?: string
  indexedSha?: string
}

export interface PullRecord {
  repo: string
  number: number
  headSha: string
  headSeenAt: string
  baselineSha?: string
  eligible: boolean
  state: 'open' | 'gone'
}

export interface JobRecord {
  id: number
  repo: string
  number: number
  headSha: string
  status: JobStatus
  attempts: number
  notBefore: string
  reason?: string
  errorKind?: FailureKind
  error?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
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

export interface PauseState {
  until: string
  reason: string
  streak: number
}

export interface HistoryStatus {
  repos: RepoRecord[]
  queued: JobRecord[]
  running: JobRecord[]
  failed: JobRecord[]
  lastRuns: RunRecord[]
  pause?: PauseState
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
  addRun(run: RunRecord): number
  watchRunsSince(iso: string): string[]
  pause(): PauseState | undefined
  setPause(state: PauseState | undefined): void
  status(): HistoryStatus
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

const REPO_COLUMNS = {
  repo: 'repo',
  pullsEtag: 'pulls_etag',
  baselineAt: 'baseline_at',
  checkedAt: 'checked_at',
  defaultBranch: 'default_branch',
  branchEtag: 'branch_etag',
  branchCheckedAt: 'branch_checked_at',
  indexedSha: 'indexed_sha',
} as const

const PULL_COLUMNS = {
  repo: 'repo',
  number: 'number',
  headSha: 'head_sha',
  headSeenAt: 'head_seen_at',
  baselineSha: 'baseline_sha',
  eligible: 'eligible',
  state: 'state',
} as const

const JOB_COLUMNS = {
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
} as const

const RUN_COLUMNS = {
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
} as const

const NUMBERS = new Set(['id', 'number', 'attempts', 'jobId', 'score', 'findings'])
const BOOLEANS = new Set(['eligible', 'aiCalled'])
const LOWERCASE = new Set(['repo'])

type Columns = Readonly<Record<string, string>>
type Row = Record<string, SQLInputValue>

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
    return row === undefined ? undefined : fromRow<RepoRecord>(row, REPO_COLUMNS)
  }

  saveRepo(record: RepoRecord): void {
    this.#upsert('watched_repo', REPO_COLUMNS, record)
  }

  pulls(repo: string): PullRecord[] {
    return this.#db
      .prepare('select * from watched_pull where repo = ? order by number')
      .all(repo.toLowerCase())
      .map((row) => fromRow<PullRecord>(row, PULL_COLUMNS))
  }

  savePull(record: PullRecord): void {
    this.#upsert('watched_pull', PULL_COLUMNS, record)
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
      .map((row) => fromRow<JobRecord>(row, JOB_COLUMNS))
  }

  addJob(job: Omit<JobRecord, 'id'>): number {
    return this.#insert('job', JOB_COLUMNS, job)
  }

  updateJob(id: number, changes: Partial<Omit<JobRecord, 'id'>>): void {
    const entries = Object.entries(changes)
    if (entries.length === 0) return
    const sets = entries.map(([key]) => `${columnOf(JOB_COLUMNS, key)} = ?`)
    this.#db
      .prepare(`update job set ${sets.join(', ')} where id = ?`)
      .run(...entries.map(([key, value]) => toColumn(key, value)), id)
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

  addRun(run: RunRecord): number {
    return this.#insert('run', RUN_COLUMNS, run)
  }

  watchRunsSince(iso: string): string[] {
    return this.#db
      .prepare(
        "select started_at from run where source = 'watch' and ai_called = 1 and started_at >= ? order by started_at",
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
      .map((row) => fromRow<JobRecord>(row, JOB_COLUMNS))
    const lastRuns = this.#db
      .prepare(
        'select * from run where id in (select max(id) from run group by repo) order by repo',
      )
      .all()
      .map((row) => {
        const { resultJson: _json, ...run } = fromRow<RunRecord>(row, RUN_COLUMNS)
        return run
      })
    return {
      repos: this.#db
        .prepare('select * from watched_repo order by repo')
        .all()
        .map((row) => fromRow<RepoRecord>(row, REPO_COLUMNS)),
      queued: this.jobs({ status: ['queued'] }),
      running: this.jobs({ status: ['running'] }),
      failed,
      lastRuns,
      ...(pause === undefined ? {} : { pause }),
    }
  }

  close(): void {
    this.#db.close()
  }

  #insert(table: string, columns: Columns, record: object): number {
    const entries = Object.entries(record).filter(([, value]) => value !== undefined)
    const names = entries.map(([key]) => columnOf(columns, key))
    const result = this.#db
      .prepare(
        `insert into ${table} (${names.join(', ')}) values (${names.map(() => '?').join(', ')})`,
      )
      .run(...entries.map(([key, value]) => toColumn(key, value)))
    return Number(result.lastInsertRowid)
  }

  #upsert(table: string, columns: Columns, record: object): void {
    const names = Object.keys(columns)
    const keys = table === 'watched_repo' ? ['repo'] : ['repo', 'number']
    const values = names.map((key) => toColumn(key, (record as Record<string, unknown>)[key]))
    const updates = names
      .filter((key) => !keys.includes(key))
      .map((key) => `${columnOf(columns, key)} = excluded.${columnOf(columns, key)}`)
    this.#db
      .prepare(
        `insert into ${table} (${names.map((key) => columnOf(columns, key)).join(', ')}) values (${names.map(() => '?').join(', ')}) on conflict (${keys.join(', ')}) do update set ${updates.join(', ')}`,
      )
      .run(...values)
  }
}

function columnOf(columns: Columns, key: string): string {
  const column = columns[key]
  if (column === undefined) throw new HistoryStoreError(`Unknown history field ${key}`)
  return column
}

function toColumn(key: string, value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null
  if (BOOLEANS.has(key)) return value === true ? 1 : 0
  if (LOWERCASE.has(key)) return String(value).toLowerCase()
  if (typeof value === 'number' || typeof value === 'string') return value
  return String(value)
}

function fromRow<T>(row: Row, columns: Columns): T {
  const record: Record<string, unknown> = {}
  for (const [key, column] of Object.entries(columns)) {
    const value = row[column]
    if (value === null || value === undefined) continue
    if (BOOLEANS.has(key)) record[key] = Number(value) === 1
    else if (NUMBERS.has(key)) record[key] = Number(value)
    else record[key] = String(value)
  }
  return record as T
}
