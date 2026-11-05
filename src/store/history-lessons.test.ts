import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Miss } from '../publish/misses.js'
import { openHistoryStore } from './history-store.js'
import type { HistoryStore } from './history-store.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-lessons-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let files = 0
const fresh = () => join(dir, `h${++files}`, 'history.sqlite')

const T1 = '2026-11-01T10:00:00.000Z'
const T2 = '2026-11-02T10:00:00.000Z'

function miss(threadId: string, overrides: Partial<Miss> = {}): Miss {
  return {
    key: threadId,
    origin: 'person',
    seen: 'missed-live',
    repo: 'acme/shop',
    number: 3,
    commitSha: 'c'.repeat(40),
    threadId,
    threadUrl: `https://github.com/acme/shop/pull/3#${threadId}`,
    file: 'src/api/shop.ts',
    line: 20,
    author: 'alice',
    role: 'member',
    body: 'Validate the input at the edge.',
    createdAt: '2026-10-20T10:00:00Z',
    ...overrides,
  }
}

async function withStore(test: (store: HistoryStore) => void): Promise<void> {
  const store = await openHistoryStore(fresh())
  try {
    test(store)
  } finally {
    store.close()
  }
}

function missIds(store: HistoryStore): number[] {
  return store
    .misses({})
    .misses.map(({ id }) => id)
    .sort((a, b) => a - b)
}

describe('HistoryStore lessons', () => {
  it('records new lessons with the misses they come from, pending', () =>
    withStore((store) => {
      store.recordMisses([miss('T1'), miss('T2', { line: 40 }), miss('T3')], T1)
      const [first, second] = missIds(store)

      const ids = store.recordLessons(
        {
          repo: 'Acme/Shop',
          provider: 'claude',
          model: 'opus',
          created: [
            {
              rule: 'Validate request bodies at the edge.',
              scope: ['src/api/**'],
              missIds: [first ?? 0, second ?? 0],
            },
          ],
          attached: [],
        },
        T1,
      )

      expect(ids).toHaveLength(1)
      expect(store.lessons({})).toEqual([
        {
          id: ids[0],
          repo: 'acme/shop',
          rule: 'Validate request bodies at the edge.',
          scope: ['src/api/**'],
          state: 'pending',
          provider: 'claude',
          model: 'opus',
          createdAt: T1,
          misses: [
            expect.objectContaining({ id: first, threadId: 'T1' }),
            expect.objectContaining({ id: second, threadId: 'T2' }),
          ],
        },
      ])
      expect([...store.linkedMissIds()].sort((a, b) => a - b)).toEqual([first, second])
    }))

  it('adds misses to a lesson already recorded, once each', () =>
    withStore((store) => {
      store.recordMisses([miss('T1'), miss('T2'), miss('T3')], T1)
      const [first, second, third] = missIds(store)
      const [lesson] = store.recordLessons(
        {
          repo: 'acme/shop',
          created: [{ rule: 'Rule.', scope: ['src/**'], missIds: [first ?? 0] }],
          attached: [],
        },
        T1,
      )

      store.recordLessons(
        {
          repo: 'acme/shop',
          created: [],
          attached: [{ lessonId: lesson ?? 0, missIds: [first ?? 0, second ?? 0, third ?? 0] }],
        },
        T2,
      )

      expect(store.lessons({})[0]?.misses.map(({ id }) => id)).toEqual([first, second, third])
    }))

  it('lists lessons by repository and state', () =>
    withStore((store) => {
      store.recordMisses([miss('T1'), miss('T2', { repo: 'acme/api' })], T1)
      const [first, second] = missIds(store)
      store.recordLessons(
        {
          repo: 'acme/shop',
          created: [{ rule: 'Shop rule.', scope: ['src/**'], missIds: [first ?? 0] }],
          attached: [],
        },
        T1,
      )
      store.recordLessons(
        {
          repo: 'acme/api',
          created: [{ rule: 'Api rule.', scope: ['src/**'], missIds: [second ?? 0] }],
          attached: [],
        },
        T2,
      )

      expect(store.lessons({ repo: 'ACME/api' }).map(({ rule }) => rule)).toEqual(['Api rule.'])
      expect(store.lessons({ states: ['accepted', 'discarded'] })).toEqual([])
      expect(store.lessons({ states: ['pending'] })).toHaveLength(2)
    }))
})
