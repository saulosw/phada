import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Language } from '../repo-map/languages.js'
import type { FileMap, SymbolKind } from '../repo-map/types.js'
import { SCHEMA, SCHEMA_VERSION } from './schema.js'

export { SCHEMA_VERSION } from './schema.js'

export type BlobStatus = 'indexed' | 'binary' | 'parse-timeout'
export type FileStatus =
  | 'indexed'
  | 'ignored'
  | 'no-grammar'
  | 'too-large'
  | 'binary'
  | 'parse-timeout'
  | 'symlink'
  | 'submodule'

export const FILE_STATUSES: readonly FileStatus[] = [
  'indexed',
  'ignored',
  'no-grammar',
  'too-large',
  'binary',
  'parse-timeout',
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
  parseErrors: number
}

export interface IndexStore {
  readonly path: string
  readonly rebuilt: boolean
  knownBlobs(oids: readonly string[]): Map<string, BlobStatus>
  saveBlob(blob: StoredBlob): void
  saveCommit(commit: StoredCommit): void
  prune(keep: number): number
  summary(sha: string): IndexSummary
  close(): void
}

export class IndexStoreError extends Error {
  override readonly name = 'IndexStoreError'
}

type Sqlite = typeof import('node:sqlite')

export interface OpenIndexStoreOptions {
  now?: () => Date
  loadSqlite?: () => Promise<Sqlite>
}

const LOOKUP_CHUNK = 500

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
    await mkdir(dirname(path), { recursive: true })
  } catch (error) {
    throw new IndexStoreError(`Cannot write the index at ${path}: ${(error as Error).message}`)
  }
  const now = options.now ?? (() => new Date())
  const opened = openDatabase(sqlite, path)
  if (opened.ok) return new SqliteIndexStore(path, opened.db, false, now)
  await removeDatabase(path)
  const recreated = openDatabase(sqlite, path)
  if (!recreated.ok) throw recreated.error
  return new SqliteIndexStore(path, recreated.db, opened.existed, now)
}

type Opened = { ok: true; db: DatabaseSync } | { ok: false; existed: boolean; error: Error }

function openDatabase(sqlite: Sqlite, path: string): Opened {
  const db = new sqlite.DatabaseSync(path)
  try {
    db.exec('pragma busy_timeout = 5000')
    db.exec('pragma journal_mode = wal')
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
      db.prepare("insert into meta (key, value) values ('schema_version', ?)").run(
        String(SCHEMA_VERSION),
      )
      db.exec('commit')
      return { ok: true, db }
    }
    const version = db.prepare("select value from meta where key = 'schema_version'").get()
    if (version?.value !== String(SCHEMA_VERSION)) {
      db.close()
      return { ok: false, existed: true, error: new Error('other schema version') }
    }
    return { ok: true, db }
  } catch (error) {
    if (!isNotADatabase(error)) {
      db.close()
      throw error
    }
    db.close()
    return { ok: false, existed: true, error: error as Error }
  }
}

function isNotADatabase(error: unknown): boolean {
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

  knownBlobs(oids: readonly string[]): Map<string, BlobStatus> {
    const known = new Map<string, BlobStatus>()
    for (let start = 0; start < oids.length; start += LOOKUP_CHUNK) {
      const chunk = oids.slice(start, start + LOOKUP_CHUNK)
      const rows = this.#db
        .prepare(`select oid, status from blob where oid in (${chunk.map(() => '?').join(',')})`)
        .all(...chunk)
      for (const row of rows) known.set(String(row.oid), row.status as BlobStatus)
    }
    return new Map(oids.filter((oid) => known.has(oid)).map((oid) => [oid, known.get(oid)!]))
  }

  saveBlob(blob: StoredBlob): void {
    this.#transaction(() => {
      this.#db.prepare('delete from blob where oid = ?').run(blob.oid)
      this.#db
        .prepare(
          'insert into blob (oid, language, bytes, status, parse_errors, indexed_at) values (?, ?, ?, ?, ?, ?)',
        )
        .run(
          blob.oid,
          blob.language,
          blob.bytes,
          blob.status,
          blob.map?.parseErrors ?? 0,
          this.#now().toISOString(),
        )
      if (blob.map !== undefined) this.#saveMap(blob.oid, blob.map)
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
        'insert into snapshot_file (commit_sha, path, blob_oid, language, status) values (?, ?, ?, ?, ?)',
      )
      for (const file of commit.files) {
        insert.run(commit.sha, file.path, file.oid ?? null, file.language ?? null, file.status)
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
      this.#db
        .prepare(
          'delete from blob where oid not in (select blob_oid from snapshot_file where blob_oid is not null)',
        )
        .run()
    })
    return removed
  }

  summary(sha: string): IndexSummary {
    const files = Object.fromEntries(FILE_STATUSES.map((status) => [status, 0])) as Record<
      FileStatus,
      number
    >
    for (const row of this.#db
      .prepare(
        'select status, count(*) as n from snapshot_file where commit_sha = ? group by status',
      )
      .all(sha)) {
      files[row.status as FileStatus] = Number(row.n)
    }
    const indexed =
      "from snapshot_file f join %s on %s.blob_oid = f.blob_oid where f.commit_sha = ? and f.status = 'indexed'"
    const grouped = (table: string, column: string) =>
      Object.fromEntries(
        this.#db
          .prepare(
            `select ${table}.${column} as key, count(*) as n ${indexed.replaceAll('%s', table)} group by ${table}.${column}`,
          )
          .all(sha)
          .map((row) => [String(row.key), Number(row.n)]),
      )
    const counted = (table: string) =>
      Number(
        this.#db.prepare(`select count(*) as n ${indexed.replaceAll('%s', table)}`).get(sha)?.n ??
          0,
      )
    const languages = Object.fromEntries(
      this.#db
        .prepare(
          "select language, count(*) as n from snapshot_file where commit_sha = ? and status = 'indexed' group by language",
        )
        .all(sha)
        .map((row) => [String(row.language), Number(row.n)]),
    )
    const parseErrors = this.#db
      .prepare(
        "select coalesce(sum(b.parse_errors), 0) as n from snapshot_file f join blob b on b.oid = f.blob_oid where f.commit_sha = ? and f.status = 'indexed'",
      )
      .get(sha)
    return {
      files,
      languages,
      symbols: grouped('symbol', 'kind'),
      imports: counted('import_item'),
      exports: counted('export_item'),
      calls: counted('call_site'),
      parseErrors: Number(parseErrors?.n ?? 0),
    }
  }

  close(): void {
    this.#db.close()
  }

  #saveMap(oid: string, map: FileMap): void {
    const ids: number[] = []
    const insertSymbol = this.#db.prepare(
      'insert into symbol (blob_oid, kind, name, container, start_line, end_line, exported, signature) values (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const symbol of map.symbols) {
      const result = insertSymbol.run(
        oid,
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
      'insert into import_item (blob_oid, module, name, alias, kind, line) values (?, ?, ?, ?, ?, ?)',
    )
    for (const item of map.imports) {
      insertImport.run(
        oid,
        item.module,
        item.name ?? null,
        item.alias ?? null,
        item.kind,
        item.line,
      )
    }
    const insertExport = this.#db.prepare(
      'insert into export_item (blob_oid, name, local_name, module, line) values (?, ?, ?, ?, ?)',
    )
    for (const item of map.exports) {
      insertExport.run(oid, item.name, item.local ?? null, item.module ?? null, item.line)
    }
    const insertCall = this.#db.prepare(
      'insert into call_site (blob_oid, caller_id, name, qualifier, line, constructs) values (?, ?, ?, ?, ?, ?)',
    )
    for (const call of map.calls) {
      const caller = call.caller === undefined ? null : (ids[call.caller] ?? null)
      insertCall.run(
        oid,
        caller,
        call.name,
        call.qualifier ?? null,
        call.line,
        call.constructs ? 1 : 0,
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
