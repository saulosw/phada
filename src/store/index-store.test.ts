import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import type { FileMap } from '../repo-map/types.js'
import { IndexStoreError, openIndexStore, SCHEMA_VERSION } from './index-store.js'
import type { CommitFile, IndexStore } from './index-store.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-store-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let count = 0
function freshPath(): string {
  count += 1
  return join(dir, `n${count}`, 'acme', 'shop.sqlite')
}

const MAP: FileMap = {
  symbols: [
    {
      key: 0,
      kind: 'method',
      name: 'load',
      parent: 1,
      startLine: 3,
      endLine: 5,
      exported: true,
      signature: 'load(id)',
    },
    {
      key: 1,
      kind: 'class',
      name: 'Store',
      startLine: 1,
      endLine: 9,
      exported: true,
      signature: 'class Store',
    },
    {
      key: 2,
      kind: 'parameter',
      name: 'id',
      parent: 0,
      startLine: 3,
      endLine: 3,
      exported: false,
      signature: 'id',
    },
  ],
  imports: [{ module: './db', name: 'db', kind: 'default', line: 1 }],
  exports: [{ name: 'Store', line: 1 }],
  calls: [
    { caller: 0, name: 'get', qualifier: 'db', line: 4, constructs: false },
    { name: 'init', line: 10, constructs: false },
  ],
  heritage: [{ symbol: 1, name: 'Base', relation: 'extends' }],
  parseErrors: 1,
}

const FILES: CommitFile[] = [
  { path: 'src/store.ts', oid: 'a'.repeat(40), language: 'typescript', status: 'indexed' },
  { path: 'src/copy.ts', oid: 'a'.repeat(40), language: 'typescript', status: 'indexed' },
  { path: 'package-lock.json', oid: 'b'.repeat(40), status: 'ignored' },
  { path: 'README.md', oid: 'c'.repeat(40), status: 'no-grammar' },
]

async function storeWithBlob(path = freshPath()): Promise<IndexStore> {
  const store = await openIndexStore(path)
  store.saveBlob({
    oid: 'a'.repeat(40),
    language: 'typescript',
    bytes: 120,
    status: 'indexed',
    map: MAP,
  })
  return store
}

describe('openIndexStore', () => {
  it('saves blobs and commits and sums them up per path', async () => {
    const store = await storeWithBlob()
    store.saveCommit({ sha: '1'.repeat(40), ref: 'HEAD', durationMs: 12, files: FILES })

    expect(store.rebuilt).toBe(false)
    expect(store.summary('1'.repeat(40))).toEqual({
      files: {
        indexed: 2,
        ignored: 1,
        'no-grammar': 1,
        'too-large': 0,
        binary: 0,
        'parse-timeout': 0,
        'parse-failed': 0,
        missing: 0,
        symlink: 0,
        submodule: 0,
      },
      languages: { typescript: 2 },
      symbols: { method: 2, class: 2, parameter: 2 },
      imports: 2,
      exports: 2,
      calls: 4,
      parseErrors: 2,
    })
    store.close()
  })

  it('stores the owner of each symbol even when it comes later in the file', async () => {
    const path = freshPath()
    const store = await storeWithBlob(path)
    store.close()
    const db = new DatabaseSync(path)
    const rows = db
      .prepare(
        'select s.name, p.name as parent from symbol s left join symbol p on p.id = s.parent_id order by s.id',
      )
      .all()
    const calls = db
      .prepare(
        'select c.name, s.name as caller from call_site c left join symbol s on s.id = c.caller_id order by c.line',
      )
      .all()
    db.close()

    expect(rows.map((row) => ({ ...row }))).toEqual([
      { name: 'load', parent: 'Store' },
      { name: 'Store', parent: null },
      { name: 'id', parent: 'load' },
    ])
    expect(calls.map((row) => ({ ...row }))).toEqual([
      { name: 'get', caller: 'load' },
      { name: 'init', caller: null },
    ])
  })

  it('refers to blobs by a small integer id instead of repeating their SHA in every row', async () => {
    const path = freshPath()
    const store = await storeWithBlob(path)
    store.close()
    const db = new DatabaseSync(path)
    const columns = (table: string) =>
      db
        .prepare(`select name, type from pragma_table_info('${table}')`)
        .all()
        .map((row) => `${row.name} ${String(row.type).toLowerCase()}`)

    for (const table of ['symbol', 'import_item', 'export_item', 'call_site']) {
      expect(columns(table)).toContain('blob_id integer')
      expect(columns(table).join()).not.toContain('blob_oid')
    }
    expect(columns('snapshot_file')).toContain('blob_id integer')
    db.close()
  })

  it('creates its folder readable only by you', async () => {
    const path = freshPath()
    const store = await openIndexStore(path)
    store.close()

    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
    expect(statSync(dirname(dirname(path))).mode & 0o777).toBe(0o700)
  })

  it('knows which blobs it has and their status', async () => {
    const store = await storeWithBlob()
    store.saveBlob({ oid: 'd'.repeat(40), language: 'go', bytes: 9, status: 'binary' })

    expect(store.knownBlobs(['a'.repeat(40), 'd'.repeat(40), 'e'.repeat(40)])).toEqual(
      new Map([
        ['a'.repeat(40), 'indexed'],
        ['d'.repeat(40), 'binary'],
      ]),
    )
    store.close()
  })

  it('replaces a blob saved again instead of duplicating it', async () => {
    const store = await storeWithBlob()
    store.saveBlob({
      oid: 'a'.repeat(40),
      language: 'typescript',
      bytes: 120,
      status: 'indexed',
      map: MAP,
    })
    store.saveCommit({ sha: '1'.repeat(40), ref: 'HEAD', durationMs: 1, files: FILES.slice(0, 1) })

    expect(store.summary('1'.repeat(40)).symbols).toEqual({ method: 1, class: 1, parameter: 1 })
    store.close()
  })

  it('keeps the most recent commits and drops blobs no kept commit uses after a day', async () => {
    let clock = Date.parse('2026-10-01T00:00:00Z')
    const store = await openIndexStore(freshPath(), { now: () => new Date(clock) })
    store.saveBlob({
      oid: 'a'.repeat(40),
      language: 'typescript',
      bytes: 120,
      status: 'indexed',
      map: MAP,
    })
    const shared = 'a'.repeat(40)
    for (let i = 0; i < 12; i += 1) {
      const own = String(i).padStart(40, 'f')
      store.saveBlob({
        oid: own,
        language: 'go',
        bytes: 1,
        status: 'indexed',
        map: { ...MAP, symbols: [], calls: [], heritage: [] },
      })
      store.saveCommit({
        sha: String(i).padStart(40, '0'),
        ref: 'HEAD',
        durationMs: 1,
        files: [
          { path: 'shared.ts', oid: shared, language: 'typescript', status: 'indexed' },
          { path: 'own.go', oid: own, language: 'go', status: 'indexed' },
        ],
      })
    }

    clock += 25 * 60 * 60 * 1000
    expect(store.prune(10)).toBe(2)
    const known = store.knownBlobs([
      shared,
      String(0).padStart(40, 'f'),
      String(2).padStart(40, 'f'),
    ])
    expect([...known.keys()]).toEqual([shared, String(2).padStart(40, 'f')])
    expect(store.summary(String(0).padStart(40, '0')).files.indexed).toBe(0)
    store.close()
  })

  it('keeps a blob another run saved and has not attached to a commit yet', async () => {
    const path = freshPath()
    const running = await openIndexStore(path)
    const other = await openIndexStore(path)
    running.saveBlob({ oid: '9'.repeat(40), language: 'go', bytes: 1, status: 'indexed', map: MAP })

    other.saveCommit({ sha: '1'.repeat(40), ref: 'HEAD', durationMs: 1, files: [] })
    other.prune(10)

    expect(running.knownBlobs(['9'.repeat(40)]).size).toBe(1)
    running.close()
    other.close()
  })

  it('rebuilds a file that is not an index', async () => {
    const path = freshPath()
    const store = await storeWithBlob(path)
    store.close()
    writeFileSync(path, 'not sqlite at all, just text that is long enough to have a header')

    const reopened = await openIndexStore(path)

    expect(reopened.rebuilt).toBe(true)
    expect(reopened.knownBlobs(['a'.repeat(40)]).size).toBe(0)
    reopened.close()
  })

  it('rebuilds an index made by another schema version', async () => {
    const path = freshPath()
    const store = await storeWithBlob(path)
    store.close()
    const db = new DatabaseSync(path)
    db.prepare("update meta set value = '0' where key = 'schema_version'").run()
    db.close()

    const reopened = await openIndexStore(path)

    expect(SCHEMA_VERSION).toBe(1)
    expect(reopened.rebuilt).toBe(true)
    expect(reopened.knownBlobs(['a'.repeat(40)]).size).toBe(0)
    reopened.close()
  })

  it('rebuilds an index made by another version of Phada and keeps one made by the same', async () => {
    const path = freshPath()
    const store = await openIndexStore(path, { version: '1.0.0' })
    store.saveBlob({ oid: 'a'.repeat(40), language: 'go', bytes: 1, status: 'binary' })
    store.close()

    const same = await openIndexStore(path, { version: '1.0.0' })
    expect(same.rebuilt).toBe(false)
    expect(same.knownBlobs(['a'.repeat(40)]).size).toBe(1)
    same.close()

    const upgraded = await openIndexStore(path, { version: '1.1.0' })
    expect(upgraded.rebuilt).toBe(true)
    expect(upgraded.knownBlobs(['a'.repeat(40)]).size).toBe(0)
    upgraded.close()
  })

  it('lets two stores write to the same index', async () => {
    const path = freshPath()
    const first = await openIndexStore(path)
    const second = await openIndexStore(path)
    first.saveBlob({ oid: '1'.repeat(40), language: 'go', bytes: 1, status: 'binary' })
    second.saveBlob({ oid: '2'.repeat(40), language: 'go', bytes: 1, status: 'binary' })

    expect(first.knownBlobs(['1'.repeat(40), '2'.repeat(40)]).size).toBe(2)
    first.close()
    second.close()
  })

  it('syncs to disk once per checkpoint, not once per blob', async () => {
    const sqlite = await import('node:sqlite')
    const executed: string[] = []
    class RecordingDatabase extends sqlite.DatabaseSync {
      override exec(sql: string): void {
        executed.push(sql)
        super.exec(sql)
      }
    }
    const store = await openIndexStore(freshPath(), {
      loadSqlite: async () => ({ ...sqlite, DatabaseSync: RecordingDatabase }),
    })
    store.close()

    expect(executed).toContain('pragma synchronous = normal')
  })

  it('says which Node.js version it needs when SQLite is missing', async () => {
    await expect(
      openIndexStore(freshPath(), {
        loadSqlite: () => Promise.reject(new Error('no such module')),
      }),
    ).rejects.toEqual(new IndexStoreError('phada index needs Node.js 22.13 or newer'))
  })
})
