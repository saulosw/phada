import { access, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { IndexStoreError, isNotADatabase } from './index-store.js'

export const OBSERVED_SCHEMA_VERSION = 1

const SCHEMA = `
create table meta (key text primary key, value text not null);
create table observed_edge (
  id integer primary key,
  from_path text not null,
  from_kind text not null default '',
  from_owner text not null default '',
  from_name text not null default '',
  to_path text not null,
  to_kind text not null default '',
  to_owner text not null default '',
  to_name text not null default '',
  pull_request integer not null,
  commit_sha text not null,
  created_at text not null,
  unique (from_path, from_kind, from_owner, from_name, to_path, to_kind, to_owner, to_name)
);
`

export interface ObservedEndpoint {
  path: string
  kind?: string
  owner?: string
  name?: string
}

export interface ObservedEdge {
  id?: number
  from: ObservedEndpoint
  to: ObservedEndpoint
  pullRequest: number
  commit: string
  createdAt?: string
}

export interface ObservedStore {
  readonly rebuilt: boolean
  all(): ObservedEdge[]
  add(edges: readonly ObservedEdge[]): number
  close(): void
}

type Sqlite = typeof import('node:sqlite')

export interface OpenObservedStoreOptions {
  now?: () => Date
  loadSqlite?: () => Promise<Sqlite>
}

export async function openObservedStore(
  path: string,
  options: OpenObservedStoreOptions = {},
): Promise<ObservedStore> {
  let sqlite: Sqlite
  try {
    sqlite = await (options.loadSqlite ?? (() => import('node:sqlite')))()
  } catch {
    throw new IndexStoreError('Learning from reviews needs Node.js 22.13 or newer')
  }
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new IndexStoreError(`Cannot write ${path}: ${(error as Error).message}`)
  }
  const now = options.now ?? (() => new Date())
  const opened = open(sqlite, path)
  if (opened !== 'rebuild') return new SqliteObservedStore(opened, false, now)
  await Promise.all(['', '-wal', '-shm'].map((suffix) => rm(`${path}${suffix}`, { force: true })))
  const recreated = open(sqlite, path)
  if (recreated === 'rebuild') throw new IndexStoreError(`Cannot open ${path}`)
  return new SqliteObservedStore(recreated, true, now)
}

export async function readObservedEdges(
  path: string,
  options: Pick<OpenObservedStoreOptions, 'loadSqlite'> = {},
): Promise<ObservedEdge[] | 'missing' | 'unreadable'> {
  const exists = await access(path).then(
    () => true,
    () => false,
  )
  if (!exists) return 'missing'
  let db: DatabaseSync | undefined
  try {
    const sqlite = await (options.loadSqlite ?? (() => import('node:sqlite')))()
    db = new sqlite.DatabaseSync(path, { readOnly: true })
    db.exec('pragma busy_timeout = 5000')
    const version = db.prepare("select value from meta where key = 'schema_version'").get()?.value
    if (version !== String(OBSERVED_SCHEMA_VERSION)) return 'unreadable'
    return db.prepare('select * from observed_edge order by id').all().map(edgeOf)
  } catch {
    return 'unreadable'
  } finally {
    db?.close()
  }
}

function open(sqlite: Sqlite, path: string): DatabaseSync | 'rebuild' {
  let db: DatabaseSync
  try {
    db = new sqlite.DatabaseSync(path)
  } catch (error) {
    throw new IndexStoreError(`Cannot open ${path}: ${(error as Error).message}`)
  }
  try {
    db.exec('pragma busy_timeout = 5000')
    db.exec('pragma journal_mode = wal')
    const tables = Number(
      db.prepare("select count(*) as n from sqlite_master where type = 'table'").get()?.n ?? 0,
    )
    if (tables === 0) {
      db.exec(SCHEMA)
      db.prepare('insert into meta (key, value) values (?, ?)').run(
        'schema_version',
        String(OBSERVED_SCHEMA_VERSION),
      )
      return db
    }
    const version = db.prepare("select value from meta where key = 'schema_version'").get()?.value
    if (version === String(OBSERVED_SCHEMA_VERSION)) return db
    db.close()
    return 'rebuild'
  } catch (error) {
    db.close()
    if (isNotADatabase(error) || /no such table/i.test((error as Error).message)) return 'rebuild'
    throw new IndexStoreError(`Cannot open ${path}: ${(error as Error).message}`)
  }
}

class SqliteObservedStore implements ObservedStore {
  readonly rebuilt: boolean
  readonly #db: DatabaseSync
  readonly #now: () => Date

  constructor(db: DatabaseSync, rebuilt: boolean, now: () => Date) {
    this.#db = db
    this.rebuilt = rebuilt
    this.#now = now
  }

  all(): ObservedEdge[] {
    return this.#db.prepare('select * from observed_edge order by id').all().map(edgeOf)
  }

  add(edges: readonly ObservedEdge[]): number {
    const insert = this.#db.prepare(
      'insert or ignore into observed_edge (from_path, from_kind, from_owner, from_name, to_path, to_kind, to_owner, to_name, pull_request, commit_sha, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    let added = 0
    for (const edge of edges) {
      added += Number(
        insert.run(
          ...columns(edge.from),
          ...columns(edge.to),
          edge.pullRequest,
          edge.commit,
          this.#now().toISOString(),
        ).changes,
      )
    }
    return added
  }

  close(): void {
    this.#db.close()
  }
}

function edgeOf(row: Record<string, SQLInputValue>): ObservedEdge {
  return {
    id: Number(row.id),
    from: endpoint(row, 'from'),
    to: endpoint(row, 'to'),
    pullRequest: Number(row.pull_request),
    commit: String(row.commit_sha),
    createdAt: String(row.created_at),
  }
}

function columns(point: ObservedEndpoint): SQLInputValue[] {
  return [point.path, point.kind ?? '', point.owner ?? '', point.name ?? '']
}

function endpoint(row: Record<string, SQLInputValue>, side: 'from' | 'to'): ObservedEndpoint {
  const text = (key: string) => {
    const value = String(row[`${side}_${key}`] ?? '')
    return value === '' ? undefined : value
  }
  const kind = text('kind')
  const owner = text('owner')
  const name = text('name')
  return {
    path: String(row[`${side}_path`]),
    ...(kind === undefined ? {} : { kind }),
    ...(owner === undefined ? {} : { owner }),
    ...(name === undefined ? {} : { name }),
  }
}
