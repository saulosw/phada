import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Miss } from '../publish/misses.js'
import type { PublishedFinding } from './history-feedback.js'
import { HISTORY_MIGRATIONS } from './history-migrations.js'
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

function published(fingerprint: string, overrides: Partial<PublishedFinding> = {}) {
  return {
    repo: 'acme/shop',
    number: 3,
    commitSha: 'c'.repeat(40),
    fingerprint,
    file: 'src/api/shop.ts',
    line: 20,
    title: 'Missing null check',
    severity: 'P2',
    confidence: 80,
    publishedAt: T1,
    ...overrides,
  } satisfies PublishedFinding
}

function findingIds(store: HistoryStore): number[] {
  return store
    .findings({})
    .map(({ id }) => id)
    .sort((a, b) => a - b)
}

async function withStore(test: (store: HistoryStore) => void, path = fresh()): Promise<void> {
  const store = await openHistoryStore(path)
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
          kind: 'check',
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
          findings: [],
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

  it('marks the misses sent to the AI with the lessons, and a new harvest keeps the mark', () =>
    withStore((store) => {
      store.recordMisses([miss('T1'), miss('T2'), miss('T3')], T1)
      const [first, second] = missIds(store)

      store.recordLessons(
        {
          repo: 'acme/shop',
          created: [{ rule: 'Rule.', scope: ['src/**'], missIds: [first ?? 0] }],
          attached: [],
          sent: [first ?? 0, second ?? 0],
        },
        T2,
      )
      store.recordMisses([miss('T1', { body: 'Edited.' }), miss('T2')], T2)

      expect(
        store
          .misses({})
          .misses.map(({ threadId, lessonsSentAt }) => [threadId, lessonsSentAt])
          .sort(),
      ).toEqual([
        ['T1', T2],
        ['T2', T2],
        ['T3', undefined],
      ])
    }))

  it('records an avoid lesson with the findings it comes from and marks the findings sent', () =>
    withStore((store) => {
      store.recordPublished([published('f1'), published('f2', { line: 40 }), published('f3')])
      const [first, second, third] = findingIds(store)

      const [lesson] = store.recordLessons(
        {
          repo: 'acme/shop',
          created: [
            {
              kind: 'avoid',
              rule: 'Do not ask for null checks on parsed configs.',
              scope: ['src/api/**'],
              missIds: [],
              findingIds: [first ?? 0],
            },
          ],
          attached: [],
          sentFindings: [first ?? 0, second ?? 0],
        },
        T1,
      )
      store.recordLessons(
        {
          repo: 'acme/shop',
          created: [],
          attached: [{ lessonId: lesson ?? 0, missIds: [], findingIds: [first ?? 0, second ?? 0] }],
        },
        T2,
      )

      const [recorded] = store.lessons({})
      expect(recorded).toMatchObject({ kind: 'avoid', misses: [] })
      expect(recorded?.findings).toEqual([
        expect.objectContaining({ id: first, fingerprint: 'f1', title: 'Missing null check' }),
        expect.objectContaining({ id: second, fingerprint: 'f2', line: 40 }),
      ])
      expect([...store.linkedFindingIds()].sort((a, b) => a - b)).toEqual([first, second])
      expect(store.findings({}).map(({ id, lessonsSentAt }) => [id, lessonsSentAt])).toEqual([
        [first, T1],
        [second, T1],
        [third, undefined],
      ])
    }))

  it('reads the lessons of a version 9 file as check lessons without findings', async () => {
    const path = fresh()
    const v9 = await openHistoryStore(path, { migrations: HISTORY_MIGRATIONS.slice(0, 9) })
    v9.close()
    const db = new DatabaseSync(path)
    db.exec(
      `insert into lesson (id, repo, rule, scope, state, created_at)
       values (1, 'acme/shop', 'Old.', '["src/**"]', 'pending', '${T1}')`,
    )
    db.close()

    await withStore((store) => {
      expect(store.lessons({})).toMatchObject([{ rule: 'Old.', kind: 'check', findings: [] }])
      expect(store.linkedFindingIds().size).toBe(0)
    }, path)
  })

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

  it('decides a pending lesson once, keeping when', () =>
    withStore((store) => {
      store.recordMisses([miss('T1')], T1)
      const [first] = missIds(store)
      const [kept, dropped] = store.recordLessons(
        {
          repo: 'acme/shop',
          created: [
            { rule: 'Kept.', scope: ['src/**'], missIds: [first ?? 0] },
            { rule: 'Dropped.', scope: ['src/**'], missIds: [] },
          ],
          attached: [],
        },
        T1,
      )

      expect(store.decideLesson(kept ?? 0, 'accepted', T2)).toBe(true)
      expect(store.decideLesson(dropped ?? 0, 'discarded', T2)).toBe(true)
      expect(store.decideLesson(kept ?? 0, 'discarded', T2)).toBe(false)
      expect(store.decideLesson(999, 'accepted', T2)).toBe(false)

      expect(store.lessons({ id: kept ?? 0 })).toEqual([
        expect.objectContaining({ rule: 'Kept.', state: 'accepted', decidedAt: T2 }),
      ])
      expect(store.lessons({ id: dropped ?? 0 })).toEqual([
        expect.objectContaining({ rule: 'Dropped.', state: 'discarded', decidedAt: T2 }),
      ])
      expect(store.lessons({ id: 999 })).toEqual([])
    }))

  it('keeps the rule and scope an accept edited', () =>
    withStore((store) => {
      const [id] = store.recordLessons(
        {
          repo: 'acme/shop',
          created: [{ rule: 'Proposed.', scope: ['src/**'], missIds: [] }],
          attached: [],
        },
        T1,
      )

      const edit = { rule: 'Edited.', scope: ['src/api/**', 'lib/**'] }
      expect(store.decideLesson(id ?? 0, 'accepted', T2, edit)).toBe(true)
      expect(store.decideLesson(id ?? 0, 'accepted', T2, { rule: 'Later.', scope: [] })).toBe(false)

      expect(store.lessons({ id: id ?? 0 })).toEqual([
        expect.objectContaining({ ...edit, state: 'accepted', decidedAt: T2 }),
      ])
    }))
})
