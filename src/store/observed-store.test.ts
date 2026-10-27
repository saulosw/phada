import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { IndexStoreError } from './index-store.js'
import { openObservedStore, readObservedEdges } from './observed-store.js'
import type { ObservedEdge } from './observed-store.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-observed-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const EDGE: ObservedEdge = {
  from: { path: 'src/users.ts', kind: 'function', name: 'getUser' },
  to: { path: 'src/jobs.ts', kind: 'method', owner: 'Sync', name: 'run' },
  pullRequest: 12,
  commit: 'a'.repeat(40),
}

describe('openObservedStore', () => {
  it('keeps edges across openings, once each', async () => {
    const path = join(dir, 'acme', 'shop.sqlite')
    const store = await openObservedStore(path, { now: () => new Date('2026-10-15T00:00:00Z') })
    expect(store.add([EDGE, EDGE, { ...EDGE, to: { path: 'src/whole.ts' } }])).toBe(2)
    store.close()

    const reopened = await openObservedStore(path)
    const edges = reopened.all()

    expect(edges).toEqual([
      { ...EDGE, id: expect.any(Number), createdAt: '2026-10-15T00:00:00.000Z' },
      {
        ...EDGE,
        to: { path: 'src/whole.ts' },
        id: expect.any(Number),
        createdAt: '2026-10-15T00:00:00.000Z',
      },
    ])
    expect(reopened.add([EDGE])).toBe(0)
    expect(reopened.rebuilt).toBe(false)
    reopened.close()
  })

  it('rebuilds a file that is not its database', async () => {
    const path = join(dir, 'broken.sqlite')
    writeFileSync(path, 'not a database at all, just text that is long enough to matter')

    const store = await openObservedStore(path)

    expect(store.rebuilt).toBe(true)
    expect(store.all()).toEqual([])
    store.close()
  })

  it('keeps what it learned when the database is busy, and says so with an index error', async () => {
    const path = join(dir, 'busy', 'shop.sqlite')
    const first = await openObservedStore(path)
    first.add([EDGE])
    first.close()
    const sqlite = await import('node:sqlite')
    class Busy extends sqlite.DatabaseSync {
      override exec(sql: string): void {
        if (sql.startsWith('pragma journal_mode')) throw new Error('database is locked')
        super.exec(sql)
      }
    }

    await expect(
      openObservedStore(path, { loadSqlite: async () => ({ ...sqlite, DatabaseSync: Busy }) }),
    ).rejects.toThrow(IndexStoreError)

    const reopened = await openObservedStore(path)
    expect(reopened.all()).toHaveLength(1)
    expect(reopened.rebuilt).toBe(false)
    reopened.close()
  })

  it('reports a database it cannot open as an index error', async () => {
    const sqlite = await import('node:sqlite')
    class Unopenable {
      constructor() {
        throw new Error('unable to open database file')
      }
    }

    await expect(
      openObservedStore(join(dir, 'x', 'y.sqlite'), {
        loadSqlite: async () => ({ ...sqlite, DatabaseSync: Unopenable as never }),
      }),
    ).rejects.toThrow(IndexStoreError)
  })
})

describe('readObservedEdges', () => {
  it('reads the edges of an existing file', async () => {
    const path = join(dir, 'read', 'shop.sqlite')
    const store = await openObservedStore(path, { now: () => new Date('2026-10-15T00:00:00Z') })
    store.add([EDGE])
    store.close()

    expect(await readObservedEdges(path)).toEqual([
      { ...EDGE, id: expect.any(Number), createdAt: '2026-10-15T00:00:00.000Z' },
    ])
  })

  it('never creates a missing file', async () => {
    const path = join(dir, 'absent', 'shop.sqlite')

    expect(await readObservedEdges(path)).toBe('missing')
    expect(existsSync(join(dir, 'absent'))).toBe(false)
  })

  it('leaves a file of another version or another kind as it is, unreadable', async () => {
    const other = join(dir, 'other-version.sqlite')
    const store = await openObservedStore(other)
    store.close()
    const db = new DatabaseSync(other)
    db.prepare("update meta set value = '99' where key = 'schema_version'").run()
    db.close()
    const text = join(dir, 'text.sqlite')
    writeFileSync(text, 'not a database at all, just text that is long enough to matter')

    expect(await readObservedEdges(other)).toBe('unreadable')
    expect(await readObservedEdges(text)).toBe('unreadable')
    const reopened = new DatabaseSync(other, { readOnly: true })
    expect(
      reopened.prepare("select value from meta where key = 'schema_version'").get()?.value,
    ).toBe('99')
    reopened.close()
    expect(readFileSync(text, 'utf8')).toContain('not a database at all')
  })
})
