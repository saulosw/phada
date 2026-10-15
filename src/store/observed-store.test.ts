import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openObservedStore } from './observed-store.js'
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
    reopened.remove([edges[0]?.id ?? -1])
    expect(reopened.all()).toHaveLength(1)
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
})
