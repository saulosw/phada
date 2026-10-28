import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import type { FileMap } from '../repo-map/types.js'
import {
  blobKey,
  IndexStoreError,
  openExistingIndexStore,
  openIndexStore,
  SCHEMA_VERSION,
} from './index-store.js'
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
  references: [{ owner: 0, name: 'Row', line: 3 }],
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
      references: 2,
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

    expect(
      store.knownBlobs([
        { oid: 'a'.repeat(40), language: 'typescript' },
        { oid: 'd'.repeat(40), language: 'go' },
        { oid: 'e'.repeat(40), language: 'go' },
      ]),
    ).toEqual(
      new Map([
        [blobKey('a'.repeat(40), 'typescript'), 'indexed'],
        [blobKey('d'.repeat(40), 'go'), 'binary'],
      ]),
    )
    store.close()
  })

  it('keeps one blob per language for the same content', async () => {
    const store = await storeWithBlob()
    store.saveBlob({ oid: 'a'.repeat(40), language: 'tsx', bytes: 120, status: 'parse-failed' })

    expect(
      store.knownBlobs([
        { oid: 'a'.repeat(40), language: 'typescript' },
        { oid: 'a'.repeat(40), language: 'tsx' },
        { oid: 'a'.repeat(40), language: 'javascript' },
      ]),
    ).toEqual(
      new Map([
        [blobKey('a'.repeat(40), 'typescript'), 'indexed'],
        [blobKey('a'.repeat(40), 'tsx'), 'parse-failed'],
      ]),
    )
    store.saveCommit({
      sha: '1'.repeat(40),
      ref: 'HEAD',
      durationMs: 1,
      files: [
        { path: 'a.ts', oid: 'a'.repeat(40), language: 'typescript', status: 'indexed' },
        { path: 'a.tsx', oid: 'a'.repeat(40), language: 'tsx', status: 'parse-failed' },
      ],
    })
    expect(store.summary('1'.repeat(40)).symbols).toEqual({ method: 1, class: 1, parameter: 1 })
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
        map: { ...MAP, symbols: [], calls: [], heritage: [], references: [] },
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
      { oid: shared, language: 'typescript' },
      { oid: String(0).padStart(40, 'f'), language: 'go' },
      { oid: String(2).padStart(40, 'f'), language: 'go' },
    ])
    expect([...known.keys()]).toEqual([
      blobKey(shared, 'typescript'),
      blobKey(String(2).padStart(40, 'f'), 'go'),
    ])
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

    expect(running.knownBlobs([{ oid: '9'.repeat(40), language: 'go' }]).size).toBe(1)
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
    expect(reopened.knownBlobs([{ oid: 'a'.repeat(40), language: 'typescript' }]).size).toBe(0)
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

    expect(SCHEMA_VERSION).toBe(3)
    expect(reopened.rebuilt).toBe(true)
    expect(reopened.knownBlobs([{ oid: 'a'.repeat(40), language: 'typescript' }]).size).toBe(0)
    reopened.close()
  })

  it('rebuilds an index made by another version of Phada and keeps one made by the same', async () => {
    const path = freshPath()
    const store = await openIndexStore(path, { version: '1.0.0' })
    store.saveBlob({ oid: 'a'.repeat(40), language: 'go', bytes: 1, status: 'binary' })
    store.close()

    const same = await openIndexStore(path, { version: '1.0.0' })
    expect(same.rebuilt).toBe(false)
    expect(same.knownBlobs([{ oid: 'a'.repeat(40), language: 'go' }]).size).toBe(1)
    same.close()

    const upgraded = await openIndexStore(path, { version: '1.1.0' })
    expect(upgraded.rebuilt).toBe(true)
    expect(upgraded.knownBlobs([{ oid: 'a'.repeat(40), language: 'go' }]).size).toBe(0)
    upgraded.close()
  })

  it('lets two stores write to the same index', async () => {
    const path = freshPath()
    const first = await openIndexStore(path)
    const second = await openIndexStore(path)
    first.saveBlob({ oid: '1'.repeat(40), language: 'go', bytes: 1, status: 'binary' })
    second.saveBlob({ oid: '2'.repeat(40), language: 'go', bytes: 1, status: 'binary' })

    expect(
      first.knownBlobs([
        { oid: '1'.repeat(40), language: 'go' },
        { oid: '2'.repeat(40), language: 'go' },
      ]).size,
    ).toBe(2)
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

  it('reports a database it cannot open as an index error with the path', async () => {
    const path = freshPath()
    class Unopenable {
      constructor() {
        throw new Error('unable to open database file')
      }
    }

    const sqlite = await import('node:sqlite')

    await expect(
      openIndexStore(path, {
        loadSqlite: async () => ({ ...sqlite, DatabaseSync: Unopenable as never }),
      }),
    ).rejects.toEqual(
      new IndexStoreError(`Cannot open the index at ${path}: unable to open database file`),
    )
  })

  it('says which Node.js version it needs when SQLite is missing', async () => {
    await expect(
      openIndexStore(freshPath(), {
        loadSqlite: () => Promise.reject(new Error('no such module')),
      }),
    ).rejects.toEqual(new IndexStoreError('phada index needs Node.js 22.13 or newer'))
  })
})

describe('openExistingIndexStore', () => {
  const VERSION = '1.0.0'

  function snapshotOf(path: string) {
    const folder = dirname(path)
    return {
      files: readdirSync(folder).sort(),
      bytes: readFileSync(path),
      mtime: statSync(path).mtimeMs,
    }
  }

  function expectUntouched(path: string, before: ReturnType<typeof snapshotOf>) {
    const after = snapshotOf(path)
    expect(after.bytes.equals(before.bytes)).toBe(true)
    expect(after.mtime).toBe(before.mtime)
    for (const file of after.files) {
      expect(before.files.includes(file) || /-(wal|shm)$/.test(file)).toBe(true)
    }
  }

  async function writtenIndex(
    commits: readonly { sha: string; ref: string }[],
    version = VERSION,
  ): Promise<string> {
    const path = freshPath()
    const store = await openIndexStore(path, { version })
    store.saveBlob({
      oid: 'a'.repeat(40),
      language: 'typescript',
      bytes: 120,
      status: 'indexed',
      map: MAP,
    })
    for (const { sha, ref } of commits) store.saveCommit({ sha, ref, durationMs: 12, files: FILES })
    store.close()
    return path
  }

  it('says the index is missing without creating its folder', async () => {
    const path = freshPath()

    expect(await openExistingIndexStore(path, { version: VERSION })).toEqual({
      status: 'missing',
      path,
    })
    expect(existsSync(dirname(path))).toBe(false)
  })

  it('opens the latest snapshot of the default branch with its summary, files left out and reader', async () => {
    const path = await writtenIndex([
      { sha: '1'.repeat(40), ref: 'HEAD' },
      { sha: '2'.repeat(40), ref: 'refs/phada/default' },
      { sha: '3'.repeat(40), ref: 'refs/phada/pull/7' },
    ])
    const before = snapshotOf(path)

    const opening = await openExistingIndexStore(path, { version: VERSION })

    if (opening.status !== 'open') throw new Error(`expected open, got ${opening.status}`)
    const { index } = opening
    expect(index.path).toBe(path)
    expect(index.snapshot).toEqual({
      sha: '2'.repeat(40),
      ref: 'refs/phada/default',
      indexedAt: expect.any(String),
      durationMs: 12,
    })
    expect(index.summary('2'.repeat(40))).toMatchObject({
      files: { indexed: 2, ignored: 1, 'no-grammar': 1 },
      symbols: { method: 2, class: 2, parameter: 2 },
      calls: 4,
    })
    expect(index.leftOut('2'.repeat(40))).toEqual([
      { path: 'README.md', status: 'no-grammar' },
      { path: 'package-lock.json', status: 'ignored' },
    ])
    expect([...index.reader('2'.repeat(40)).files().keys()].sort()).toEqual([
      'src/copy.ts',
      'src/store.ts',
    ])
    index.close()
    expectUntouched(path, before)
  })

  it('falls back to the latest snapshot when the default branch was never indexed', async () => {
    const path = await writtenIndex([
      { sha: '3'.repeat(40), ref: 'refs/phada/pull/7' },
      { sha: '4'.repeat(40), ref: 'refs/phada/pull/8' },
    ])

    const opening = await openExistingIndexStore(path, { version: VERSION })

    if (opening.status !== 'open') throw new Error(`expected open, got ${opening.status}`)
    expect(opening.index.snapshot?.sha).toBe('4'.repeat(40))
    opening.index.close()
  })

  it('opens an index without snapshots', async () => {
    const path = await writtenIndex([])

    const opening = await openExistingIndexStore(path, { version: VERSION })

    if (opening.status !== 'open') throw new Error(`expected open, got ${opening.status}`)
    expect(opening.index.snapshot).toBeNull()
    opening.index.close()
  })

  it('names the version that made an index of another version of Phada and leaves it as it is', async () => {
    const path = await writtenIndex([{ sha: '1'.repeat(40), ref: 'HEAD' }], '0.9.0')
    const before = snapshotOf(path)

    expect(await openExistingIndexStore(path, { version: VERSION })).toEqual({
      status: 'other-version',
      path,
      found: { schemaVersion: String(SCHEMA_VERSION), phadaVersion: '0.9.0' },
      expected: { schemaVersion: String(SCHEMA_VERSION), phadaVersion: VERSION },
    })
    expectUntouched(path, before)
  })

  it('names the schema of an index made by another schema version', async () => {
    const path = await writtenIndex([])
    const db = new DatabaseSync(path)
    db.prepare("update meta set value = '2' where key = 'schema_version'").run()
    db.close()

    const opening = await openExistingIndexStore(path, { version: VERSION })

    expect(opening).toMatchObject({
      status: 'other-version',
      found: { schemaVersion: '2', phadaVersion: VERSION },
    })
  })

  it('says why a file that is not an index cannot be read and leaves it as it is', async () => {
    const path = freshPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'not a database at all, just some text that is long enough to be a header')
    const before = snapshotOf(path)

    const opening = await openExistingIndexStore(path, { version: VERSION })

    expect(opening.status).toBe('unreadable')
    if (opening.status !== 'unreadable') return
    expect(opening.error).toBeInstanceOf(IndexStoreError)
    expect(opening.error.message).toContain(path)
    expect(opening.error.message).toMatch(/not a Phada index|not a database/i)
    expectUntouched(path, before)
  })

  it('says a database made by something else is not a Phada index', async () => {
    const path = freshPath()
    mkdirSync(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec('create table other (x)')
    db.close()

    const opening = await openExistingIndexStore(path, { version: VERSION })

    expect(opening.status).toBe('unreadable')
    if (opening.status === 'unreadable') {
      expect(opening.error.message).toContain('not a Phada index')
    }
  })
})
