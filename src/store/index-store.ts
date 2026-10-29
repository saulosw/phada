import { access, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Language } from '../repo-map/languages.js'
import type { FileMap, SymbolKind } from '../repo-map/types.js'
import { SqliteIndexReader } from './index-reader.js'
import type { IndexReader } from './index-reader.js'
import { SCHEMA, SCHEMA_VERSION } from './schema.js'

export { SCHEMA_VERSION } from './schema.js'

export type BlobStatus = 'indexed' | 'binary' | 'parse-timeout' | 'parse-failed'
export type FileStatus =
  | 'indexed'
  | 'ignored'
  | 'no-grammar'
  | 'too-large'
  | 'binary'
  | 'parse-timeout'
  | 'parse-failed'
  | 'missing'
  | 'symlink'
  | 'submodule'

export const FILE_STATUSES: readonly FileStatus[] = [
  'indexed',
  'ignored',
  'no-grammar',
  'too-large',
  'binary',
  'parse-timeout',
  'parse-failed',
  'missing',
  'symlink',
  'submodule',
]

export interface StoredBlob {
  oid: string
  language: Language
  bytes: number
  status: BlobStatus
  map?: FileMap
}

export interface BlobKey {
  oid: string
  language: Language
}

export function blobKey(oid: string, language: Language): string {
  return `${oid}:${language}`
}

export interface CommitFile {
  path: string
  oid?: string
  language?: Language
  status: FileStatus
}

export interface StoredCommit {
  sha: string
  ref: string
  durationMs: number
  files: readonly CommitFile[]
}

export interface IndexSummary {
  files: Record<FileStatus, number>
  languages: Partial<Record<Language, number>>
  symbols: Partial<Record<SymbolKind, number>>
  imports: number
  exports: number
  calls: number
  references: number
  parseErrors: number
}

export interface IndexStore {
  readonly path: string
  readonly rebuilt: boolean
  knownBlobs(blobs: readonly BlobKey[]): Map<string, BlobStatus>
  saveBlob(blob: StoredBlob): void
  saveCommit(commit: StoredCommit): void
  prune(keep: number): number
  summary(sha: string): IndexSummary
  reader(sha: string): IndexReader
  close(): void
}

export class IndexStoreError extends Error {
  override readonly name = 'IndexStoreError'
}

type Sqlite = typeof import('node:sqlite')

export interface OpenIndexStoreOptions {
  version?: string
  now?: () => Date
  loadSqlite?: () => Promise<Sqlite>
}

const LOOKUP_CHUNK = 500
export const UNUSED_BLOB_GRACE_MS = 24 * 60 * 60 * 1000

export async function openIndexStore(
  path: string,
  options: OpenIndexStoreOptions = {},
): Promise<IndexStore> {
  let sqlite: Sqlite
  try {
    sqlite = await (options.loadSqlite ?? (() => import('node:sqlite')))()
  } catch {
    throw new IndexStoreError('phada index needs Node.js 22.13 or newer')
  }
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new IndexStoreError(`Cannot write the index at ${path}: ${(error as Error).message}`)
  }
  const now = options.now ?? (() => new Date())
  const version = options.version ?? ''
  const opened = openDatabase(sqlite, path, version)
  if (opened.ok) return new SqliteIndexStore(path, opened.db, false, now)
  await removeDatabase(path)
  const recreated = openDatabase(sqlite, path, version)
  if (!recreated.ok) throw recreated.error
  return new SqliteIndexStore(path, recreated.db, opened.existed, now)
}

export const RELATED_REF = 'refs/phada/default'
const DEFAULT_BRANCH_REFS: readonly string[] = ['HEAD', RELATED_REF]

export interface IndexSnapshot {
  sha: string
  ref: string
  defaultBranch: boolean
  indexedAt: string
  durationMs: number
}

export interface LeftOutPath {
  path: string
  status: Exclude<FileStatus, 'indexed'>
}

export interface ReadOnlyIndex {
  readonly path: string
  readonly snapshot: IndexSnapshot | null
  summary(sha: string): IndexSummary
  leftOut(sha: string): LeftOutPath[]
  reader(sha: string): IndexReader
  close(): void
}

export interface IndexVersion {
  schemaVersion: string | null
  phadaVersion: string | null
}

export type IndexOpening =
  | { status: 'open'; index: ReadOnlyIndex }
  | { status: 'missing'; path: string }
  | { status: 'other-version'; path: string; found: IndexVersion; expected: IndexVersion }
  | { status: 'unreadable'; path: string; error: IndexStoreError }

export interface OpenExistingIndexOptions {
  version: string
  loadSqlite?: () => Promise<Sqlite>
  exists?: (path: string) => Promise<boolean>
}

export async function openExistingIndexStore(
  path: string,
  options: OpenExistingIndexOptions,
): Promise<IndexOpening> {
  if (!(await (options.exists ?? fileExists)(path))) return { status: 'missing', path }
  const unreadable = (reason: string): IndexOpening => ({
    status: 'unreadable',
    path,
    error: new IndexStoreError(`Cannot read the index at ${path}: ${reason}`),
  })
  let sqlite: Sqlite
  try {
    sqlite = await (options.loadSqlite ?? (() => import('node:sqlite')))()
  } catch {
    return unreadable('reading it needs Node.js 22.13 or newer')
  }
  let db: DatabaseSync
  try {
    db = new sqlite.DatabaseSync(path, { readOnly: true })
  } catch (error) {
    return unreadable((error as Error).message)
  }
  try {
    db.exec('pragma busy_timeout = 5000')
    const hasMeta = db
      .prepare("select 1 from sqlite_master where type = 'table' and name = 'meta'")
      .get()
    if (hasMeta === undefined) {
      db.close()
      return unreadable('it is not a Phada index')
    }
    const meta = new Map(
      db
        .prepare('select key, value from meta')
        .all()
        .map((row) => [String(row.key), String(row.value)]),
    )
    const found = {
      schemaVersion: meta.get('schema_version') ?? null,
      phadaVersion: meta.get('phada_version') ?? null,
    }
    const expected = { schemaVersion: String(SCHEMA_VERSION), phadaVersion: options.version }
    if (
      found.schemaVersion !== expected.schemaVersion ||
      found.phadaVersion !== expected.phadaVersion
    ) {
      db.close()
      return { status: 'other-version', path, found, expected }
    }
    return { status: 'open', index: new SqliteReadOnlyIndex(path, db, latestSnapshot(db)) }
  } catch (error) {
    db.close()
    return unreadable(isNotADatabase(error) ? 'it is not a Phada index' : (error as Error).message)
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function latestSnapshot(db: DatabaseSync): IndexSnapshot | null {
  const refs = DEFAULT_BRANCH_REFS.map(() => '?').join(', ')
  const row =
    db
      .prepare(`select * from snapshot where ref in (${refs}) order by seq desc limit 1`)
      .get(...DEFAULT_BRANCH_REFS) ??
    db.prepare('select * from snapshot order by seq desc limit 1').get()
  if (row === undefined) return null
  return {
    sha: String(row.sha),
    ref: String(row.ref),
    defaultBranch: DEFAULT_BRANCH_REFS.includes(String(row.ref)),
    indexedAt: String(row.indexed_at),
    durationMs: Number(row.duration_ms),
  }
}

class SqliteReadOnlyIndex implements ReadOnlyIndex {
  readonly path: string
  readonly snapshot: IndexSnapshot | null
  readonly #db: DatabaseSync

  constructor(path: string, db: DatabaseSync, snapshot: IndexSnapshot | null) {
    this.path = path
    this.#db = db
    this.snapshot = snapshot
  }

  summary(sha: string): IndexSummary {
    return summarize(this.#db, sha)
  }

  leftOut(sha: string): LeftOutPath[] {
    return this.#db
      .prepare(
        "select path, status from snapshot_file where commit_sha = ? and status != 'indexed' order by path",
      )
      .all(sha)
      .map((row) => ({ path: String(row.path), status: row.status as LeftOutPath['status'] }))
  }

  reader(sha: string): IndexReader {
    return new SqliteIndexReader(this.#db, sha)
  }

  close(): void {
    this.#db.close()
  }
}

type Opened = { ok: true; db: DatabaseSync } | { ok: false; existed: boolean; error: Error }

function openDatabase(sqlite: Sqlite, path: string, phadaVersion: string): Opened {
  let db: DatabaseSync
  try {
    db = new sqlite.DatabaseSync(path)
  } catch (error) {
    throw new IndexStoreError(`Cannot open the index at ${path}: ${(error as Error).message}`)
  }
  try {
    db.exec('pragma busy_timeout = 5000')
    db.exec('pragma journal_mode = wal')
    db.exec('pragma synchronous = normal')
    db.exec('pragma foreign_keys = on')
    const hasMeta = db
      .prepare("select 1 from sqlite_master where type = 'table' and name = 'meta'")
      .get()
    if (hasMeta === undefined) {
      const tables = db
        .prepare("select count(*) as n from sqlite_master where type = 'table'")
        .get()
      if (Number(tables?.n ?? 0) > 0) {
        db.close()
        return { ok: false, existed: true, error: new Error('unknown tables') }
      }
      db.exec('begin')
      db.exec(SCHEMA)
      const insert = db.prepare('insert into meta (key, value) values (?, ?)')
      insert.run('schema_version', String(SCHEMA_VERSION))
      insert.run('phada_version', phadaVersion)
      db.exec('commit')
      return { ok: true, db }
    }
    const meta = new Map(
      db
        .prepare('select key, value from meta')
        .all()
        .map((row) => [String(row.key), String(row.value)]),
    )
    if (
      meta.get('schema_version') !== String(SCHEMA_VERSION) ||
      meta.get('phada_version') !== phadaVersion
    ) {
      db.close()
      return { ok: false, existed: true, error: new Error('made by another version') }
    }
    return { ok: true, db }
  } catch (error) {
    if (!isNotADatabase(error)) {
      db.close()
      throw new IndexStoreError(`Cannot open the index at ${path}: ${(error as Error).message}`)
    }
    db.close()
    return { ok: false, existed: true, error: error as Error }
  }
}

export function isNotADatabase(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /not a database|malformed|file is encrypted/i.test(message)
}

async function removeDatabase(path: string): Promise<void> {
  await Promise.all(['', '-wal', '-shm'].map((suffix) => rm(`${path}${suffix}`, { force: true })))
}

class SqliteIndexStore implements IndexStore {
  readonly path: string
  readonly rebuilt: boolean
  readonly #db: DatabaseSync
  readonly #now: () => Date

  constructor(path: string, db: DatabaseSync, rebuilt: boolean, now: () => Date) {
    this.path = path
    this.#db = db
    this.rebuilt = rebuilt
    this.#now = now
  }

  knownBlobs(blobs: readonly BlobKey[]): Map<string, BlobStatus> {
    const oids = [...new Set(blobs.map((blob) => blob.oid))]
    const stored = new Map<string, BlobStatus>()
    for (let start = 0; start < oids.length; start += LOOKUP_CHUNK) {
      const chunk = oids.slice(start, start + LOOKUP_CHUNK)
      const rows = this.#db
        .prepare(
          `select oid, language, status from blob where oid in (${chunk.map(() => '?').join(',')})`,
        )
        .all(...chunk)
      for (const row of rows) {
        stored.set(blobKey(String(row.oid), row.language as Language), row.status as BlobStatus)
      }
    }
    const known = new Map<string, BlobStatus>()
    for (const blob of blobs) {
      const key = blobKey(blob.oid, blob.language)
      const status = stored.get(key)
      if (status !== undefined) known.set(key, status)
    }
    return known
  }

  saveBlob(blob: StoredBlob): void {
    this.#transaction(() => {
      const values = [
        blob.language,
        blob.bytes,
        blob.status,
        blob.map?.parseErrors ?? 0,
        this.#now().toISOString(),
      ] as const
      const existing = this.#db
        .prepare('select id from blob where oid = ? and language = ?')
        .get(blob.oid, blob.language)
      let id: number
      if (existing === undefined) {
        id = Number(
          this.#db
            .prepare(
              'insert into blob (language, bytes, status, parse_errors, indexed_at, oid) values (?, ?, ?, ?, ?, ?)',
            )
            .run(...values, blob.oid).lastInsertRowid,
        )
      } else {
        id = Number(existing.id)
        this.#db
          .prepare(
            'update blob set language = ?, bytes = ?, status = ?, parse_errors = ?, indexed_at = ? where id = ?',
          )
          .run(...values, id)
        for (const table of ['symbol', 'import_item', 'export_item', 'call_site', 'reference']) {
          this.#db.prepare(`delete from ${table} where blob_id = ?`).run(id)
        }
      }
      if (blob.map !== undefined) this.#saveMap(id, blob.map)
    })
  }

  saveCommit(commit: StoredCommit): void {
    this.#transaction(() => {
      const next = this.#db.prepare('select coalesce(max(seq), 0) + 1 as seq from snapshot').get()
      this.#db.prepare('delete from snapshot where sha = ?').run(commit.sha)
      this.#db
        .prepare(
          'insert into snapshot (sha, ref, indexed_at, duration_ms, seq) values (?, ?, ?, ?, ?)',
        )
        .run(
          commit.sha,
          commit.ref,
          this.#now().toISOString(),
          commit.durationMs,
          Number(next?.seq),
        )
      const insert = this.#db.prepare(
        'insert into snapshot_file (commit_sha, path, blob_id, language, status) values (?, ?, ?, ?, ?)',
      )
      const blobId = this.#db.prepare('select id from blob where oid = ? and language = ?')
      for (const file of commit.files) {
        const blob =
          file.oid === undefined || file.language === undefined
            ? undefined
            : blobId.get(file.oid, file.language)
        insert.run(
          commit.sha,
          file.path,
          blob === undefined ? null : Number(blob.id),
          file.language ?? null,
          file.status,
        )
      }
    })
  }

  prune(keep: number): number {
    let removed = 0
    this.#transaction(() => {
      removed = Number(
        this.#db
          .prepare(
            'delete from snapshot where sha not in (select sha from snapshot order by seq desc limit ?)',
          )
          .run(keep).changes,
      )
      const cutoff = new Date(this.#now().getTime() - UNUSED_BLOB_GRACE_MS).toISOString()
      this.#db
        .prepare(
          'delete from blob where indexed_at < ? and id not in (select blob_id from snapshot_file where blob_id is not null)',
        )
        .run(cutoff)
    })
    return removed
  }

  summary(sha: string): IndexSummary {
    return summarize(this.#db, sha)
  }

  reader(sha: string): IndexReader {
    return new SqliteIndexReader(this.#db, sha)
  }

  close(): void {
    this.#db.close()
  }

  #saveMap(blobId: number, map: FileMap): void {
    const ids: number[] = []
    const insertSymbol = this.#db.prepare(
      'insert into symbol (blob_id, kind, name, container, start_line, end_line, exported, signature) values (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const symbol of map.symbols) {
      const result = insertSymbol.run(
        blobId,
        symbol.kind,
        symbol.name,
        symbol.container ?? null,
        symbol.startLine,
        symbol.endLine,
        symbol.exported ? 1 : 0,
        symbol.signature,
      )
      ids[symbol.key] = Number(result.lastInsertRowid)
    }
    const setParent = this.#db.prepare('update symbol set parent_id = ? where id = ?')
    for (const symbol of map.symbols) {
      const parent = symbol.parent === undefined ? undefined : ids[symbol.parent]
      if (parent !== undefined) setParent.run(parent, ids[symbol.key] ?? null)
    }
    const insertImport = this.#db.prepare(
      'insert into import_item (blob_id, module, name, alias, kind, line) values (?, ?, ?, ?, ?, ?)',
    )
    for (const item of map.imports) {
      insertImport.run(
        blobId,
        item.module,
        item.name ?? null,
        item.alias ?? null,
        item.kind,
        item.line,
      )
    }
    const insertExport = this.#db.prepare(
      'insert into export_item (blob_id, name, local_name, module, line) values (?, ?, ?, ?, ?)',
    )
    for (const item of map.exports) {
      insertExport.run(blobId, item.name, item.local ?? null, item.module ?? null, item.line)
    }
    const insertCall = this.#db.prepare(
      'insert into call_site (blob_id, caller_id, name, qualifier, line, constructs) values (?, ?, ?, ?, ?, ?)',
    )
    for (const call of map.calls) {
      const caller = call.caller === undefined ? null : (ids[call.caller] ?? null)
      insertCall.run(
        blobId,
        caller,
        call.name,
        call.qualifier ?? null,
        call.line,
        call.constructs ? 1 : 0,
      )
    }
    const insertReference = this.#db.prepare(
      'insert into reference (blob_id, owner_id, name, qualifier, line) values (?, ?, ?, ?, ?)',
    )
    for (const reference of map.references) {
      const owner = reference.owner === undefined ? null : (ids[reference.owner] ?? null)
      insertReference.run(
        blobId,
        owner,
        reference.name,
        reference.qualifier ?? null,
        reference.line,
      )
    }
    const insertHeritage = this.#db.prepare(
      'insert into heritage (symbol_id, name, relation) values (?, ?, ?)',
    )
    for (const item of map.heritage) {
      const symbol = ids[item.symbol]
      if (symbol !== undefined) insertHeritage.run(symbol, item.name, item.relation)
    }
  }

  #transaction(work: () => void): void {
    this.#db.exec('begin immediate')
    try {
      work()
      this.#db.exec('commit')
    } catch (error) {
      this.#db.exec('rollback')
      throw error
    }
  }
}

function summarize(db: DatabaseSync, sha: string): IndexSummary {
  const files = Object.fromEntries(FILE_STATUSES.map((status) => [status, 0])) as Record<
    FileStatus,
    number
  >
  for (const row of db
    .prepare('select status, count(*) as n from snapshot_file where commit_sha = ? group by status')
    .all(sha)) {
    files[row.status as FileStatus] = Number(row.n)
  }
  const indexed =
    "from snapshot_file f join %s on %s.blob_id = f.blob_id where f.commit_sha = ? and f.status = 'indexed'"
  const grouped = (table: string, column: string) =>
    Object.fromEntries(
      db
        .prepare(
          `select ${table}.${column} as key, count(*) as n ${indexed.replaceAll('%s', table)} group by ${table}.${column}`,
        )
        .all(sha)
        .map((row) => [String(row.key), Number(row.n)]),
    )
  const counted = (table: string) =>
    Number(db.prepare(`select count(*) as n ${indexed.replaceAll('%s', table)}`).get(sha)?.n ?? 0)
  const languages = Object.fromEntries(
    db
      .prepare(
        "select language, count(*) as n from snapshot_file where commit_sha = ? and status = 'indexed' group by language",
      )
      .all(sha)
      .map((row) => [String(row.language), Number(row.n)]),
  )
  const parseErrors = db
    .prepare(
      "select coalesce(sum(b.parse_errors), 0) as n from snapshot_file f join blob b on b.id = f.blob_id where f.commit_sha = ? and f.status = 'indexed'",
    )
    .get(sha)
  return {
    files,
    languages,
    symbols: grouped('symbol', 'kind'),
    imports: counted('import_item'),
    exports: counted('export_item'),
    calls: counted('call_site'),
    references: counted('reference'),
    parseErrors: Number(parseErrors?.n ?? 0),
  }
}
