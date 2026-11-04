import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Miss } from '../publish/misses.js'
import { openHistoryStore } from './history-store.js'
import type { HistoryStore, RunRecord } from './history-store.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-misses-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let files = 0
const fresh = () => join(dir, `h${++files}`, 'history.sqlite')

const T1 = '2026-10-20T11:00:00.000Z'
const T2 = '2026-10-20T12:00:00.000Z'

function miss(overrides: Partial<Miss> = {}): Miss {
  return {
    key: overrides.threadId ?? 'T9',
    origin: 'person',
    seen: 'missed-live',
    repo: 'Acme/Shop',
    number: 3,
    reviewedSha: 'a'.repeat(40),
    commitSha: 'c'.repeat(40),
    threadId: 'T9',
    threadUrl: 'https://github.com/acme/shop/pull/3#discussion_r9',
    file: 'src/shop.ts',
    startLine: 20,
    line: 22,
    author: 'alice',
    role: 'member',
    body: 'This loses the balance.',
    createdAt: '2026-10-20T10:00:00Z',
    ...overrides,
  }
}

const RUN: RunRecord = {
  source: 'watch',
  repo: 'acme/shop',
  number: 3,
  headSha: 'a'.repeat(40),
  startedAt: T1,
  finishedAt: T1,
  status: 'published',
  aiCalled: true,
  provider: 'claude',
  findings: 0,
  resultJson: '{"review":{"findings":[]}}',
}

async function withStore(test: (store: HistoryStore) => void): Promise<void> {
  const store = await openHistoryStore(fresh())
  try {
    test(store)
  } finally {
    store.close()
  }
}

describe('HistoryStore misses', () => {
  it('records a miss once per thread and says how many are new', () =>
    withStore((store) => {
      expect(store.recordMisses([miss(), miss({ threadId: 'T10', line: 40 })], T1)).toBe(2)
      expect(store.recordMisses([miss({ body: 'Edited.' })], T2)).toBe(0)

      const { misses, total } = store.misses({})

      expect(total).toBe(2)
      expect(misses).toHaveLength(2)
      expect(misses.find(({ threadId }) => threadId === 'T9')).toEqual({
        ...miss({ body: 'Edited.' }),
        id: expect.any(Number),
        repo: 'acme/shop',
        state: 'open',
        harvestedAt: T1,
      })
    }))

  it('records misses without a thread once per key, and a key harvested again updates its miss', () =>
    withStore((store) => {
      const found = (key: string, line: number): Miss => ({
        key,
        origin: 'phada',
        seen: 'missed-live',
        repo: 'acme/shop',
        number: 3,
        commitSha: 'c'.repeat(40),
        file: 'src/shop.ts',
        line,
        author: 'phada',
        body: 'The timeout is never read.',
        createdAt: '2026-10-20T10:00:00Z',
      })

      expect(store.recordMisses([found('phada:4:a', 10), found('phada:5:a', 12)], T1)).toBe(2)
      expect(store.recordMisses([found('phada:4:a', 11)], T2)).toBe(0)

      expect(store.misses({}).misses).toEqual([
        { ...found('phada:5:a', 12), id: expect.any(Number), state: 'open', harvestedAt: T1 },
        { ...found('phada:4:a', 11), id: expect.any(Number), state: 'open', harvestedAt: T1 },
      ])
    }))

  it('a dismissed miss stays dismissed when it is harvested again', () =>
    withStore((store) => {
      store.recordMisses([miss()], T1)
      const [recorded] = store.misses({}).misses

      expect(store.dismissMiss(recorded?.id ?? 0)).toBe(true)
      store.recordMisses([miss()], T2)

      expect(store.misses({}).misses).toMatchObject([{ state: 'dismissed', harvestedAt: T1 }])
      expect(store.dismissMiss(999)).toBe(false)
    }))

  it('lists misses by repository, pull request and state, newest first', () =>
    withStore((store) => {
      store.recordMisses(
        [
          miss({ threadId: 'A', createdAt: '2026-10-20T08:00:00Z' }),
          miss({ threadId: 'B', createdAt: '2026-10-20T09:00:00Z', number: 4 }),
          miss({ threadId: 'C', repo: 'acme/other' }),
        ],
        T1,
      )
      const [first] = store.misses({ repo: 'ACME/shop', number: 3 }).misses
      store.dismissMiss(first?.id ?? 0)

      expect(store.misses({ repo: 'acme/shop' }).misses.map(({ threadId }) => threadId)).toEqual([
        'B',
        'A',
      ])
      expect(store.misses({ repo: 'acme/shop', state: 'open' }).misses).toMatchObject([
        { threadId: 'B' },
      ])
      expect(store.misses({ limit: 1 })).toMatchObject({ total: 3, misses: [{ threadId: 'C' }] })
    }))

  it('reads the runs of a pull request where the AI was called, outside replays', () =>
    withStore((store) => {
      store.addRun({ ...RUN, finishedAt: T2, status: 'dry-run', source: 'manual' })
      store.addRun(RUN)
      store.addRun({ ...RUN, source: 'replay', status: 'dry-run' })
      store.addRun({ ...RUN, aiCalled: false, status: 'skipped' })
      store.addRun({ ...RUN, number: 4 })

      expect(
        store
          .aiRuns({ repo: 'Acme/Shop', number: 3 })
          .map(({ finishedAt, source }) => [finishedAt, source]),
      ).toEqual([
        [T1, 'watch'],
        [T2, 'manual'],
      ])
      expect(
        store
          .aiRuns({ repo: 'Acme/Shop', number: 3 }, { replays: true })
          .map(({ id, finishedAt, source }) => [id, finishedAt, source]),
      ).toEqual([
        [2, T1, 'watch'],
        [3, T1, 'replay'],
        [1, T2, 'manual'],
      ])
    }))

  it('keeps one replay result per miss and Phada version, the last one wins', () =>
    withStore((store) => {
      store.recordMisses([miss(), miss({ threadId: 'T10', line: 40 })], T1)
      const [first, second] = store.misses({}).misses.map(({ id }) => id)
      const runId = store.addRun({ ...RUN, source: 'replay', status: 'dry-run' })

      store.recordMissReplays([
        { missId: first ?? 0, version: '0.11.1', outcome: 'missed', replayedAt: T1 },
        { missId: second ?? 0, version: '0.11.1', outcome: 'missed', replayedAt: T1 },
      ])
      store.recordMissReplays([
        { missId: first ?? 0, version: '0.12.0', runId, outcome: 'missed', replayedAt: T1 },
      ])
      store.recordMissReplays([
        { missId: first ?? 0, version: '0.12.0', runId, outcome: 'caught', replayedAt: T2 },
      ])

      expect(store.missReplays([first ?? 0])).toEqual([
        { missId: first, version: '0.11.1', outcome: 'missed', replayedAt: T1 },
        { missId: first, version: '0.12.0', runId, outcome: 'caught', replayedAt: T2 },
      ])
      expect(store.missReplays([second ?? 0])).toHaveLength(1)
      expect(store.missReplays([])).toEqual([])
    }))
})
