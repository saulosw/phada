import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { IndexStoreError } from './index-store.js'

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
  remove(ids: readonly number[]): void
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
  if (opened !== undefined) return new SqliteObservedStore(opened, false, now)
  await Promise.all(['', '-wal', '-shm'].map((suffix) => rm(`${path}${suffix}`, { force: true })))
  const recreated = open(sqlite, path)
  if (recreated === undefined) throw new IndexStoreError(`Cannot open ${path}`)
  return new SqliteObservedStore(recreated, true, now)
}

function open(sqlite: Sqlite, path: string): DatabaseSync | undefined {
  const db = new sqlite.DatabaseSync(path)
  try {
    db.exec('pragma busy_timeout = 5000')
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
  } catch {}
  db.close()
  return undefined
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
    return this.#db
      .prepare('select * from observed_edge order by id')
      .all()
      .map((row) => ({
        id: Number(row.id),
        from: endpoint(row, 'from'),
        to: endpoint(row, 'to'),
        pullRequest: Number(row.pull_request),
        commit: String(row.commit_sha),
        createdAt: String(row.created_at),
      }))
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

  remove(ids: readonly number[]): void {
    const statement = this.#db.prepare('delete from observed_edge where id = ?')
    for (const id of ids) statement.run(id)
  }

  close(): void {
    this.#db.close()
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
