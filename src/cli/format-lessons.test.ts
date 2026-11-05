import { describe, expect, it } from 'vitest'
import type { LessonList } from '../app/read-lessons.js'
import type { LessonRecord, MissRecord } from '../store/history-store.js'
import { formatLessonsJson, formatLessonsText } from './format-lessons.js'

function miss(id: number, overrides: Partial<MissRecord> = {}): MissRecord {
  return {
    id,
    key: `T${id}`,
    origin: 'person',
    seen: 'missed-live',
    repo: 'acme/shop',
    number: 3,
    commitSha: 'c'.repeat(40),
    threadId: `T${id}`,
    threadUrl: `https://github.com/acme/shop/pull/3#discussion_r${id}`,
    file: 'src/api/orders.ts',
    line: 22,
    author: 'alice',
    role: 'member',
    body: 'Validate the body.',
    createdAt: '2026-10-20T11:00:00Z',
    harvestedAt: '2026-10-22T12:00:00.000Z',
    state: 'open',
    ...overrides,
  }
}

const LESSON: LessonRecord = {
  id: 7,
  repo: 'acme/shop',
  rule: 'Validate request bodies at the edge.\nReturn 400 on a bad body.',
  scope: ['src/api/**', 'src/db/**'],
  state: 'pending',
  provider: 'claude',
  model: 'opus',
  createdAt: '2026-11-04T10:00:00.000Z',
  misses: [miss(1), miss(2, { number: 4, threadUrl: '', file: 'src/db/pool.ts', line: 9 })],
}

describe('formatLessonsText', () => {
  it('shows each lesson with its whole rule, scope and the threads it comes from', () => {
    expect(formatLessonsText({ lessons: [LESSON], hidden: 0 }, false)).toBe(
      [
        '   7  acme/shop  pending  2 misses',
        '      Validate request bodies at the edge.',
        '      Return 400 on a bad body.',
        '      files: src/api/**, src/db/**',
        '      https://github.com/acme/shop/pull/3#discussion_r1',
        '      acme/shop#4 src/db/pool.ts:9',
        '',
      ].join('\n'),
    )
  })

  it('says how many decided lessons it hides, and when there is none', () => {
    const one: LessonList = { lessons: [{ ...LESSON, misses: [miss(1)] }], hidden: 2 }

    expect(formatLessonsText(one, false)).toContain('1 miss\n')
    expect(formatLessonsText(one, false)).toContain(
      '2 accepted or discarded lessons not shown; add --all to see them.',
    )
    expect(formatLessonsText({ lessons: [], hidden: 0 }, false)).toBe(
      'No lessons in the history yet; phada lessons --refresh proposes them from the misses.\n',
    )
  })

  it('cleans the text people and the AI wrote before it reaches the terminal', () => {
    const text = formatLessonsText(
      { lessons: [{ ...LESSON, rule: 'Bad \u001b[31mred\u001b[0m rule.' }], hidden: 0 },
      false,
    )

    expect(text).not.toContain('\u001b')
  })
})

describe('formatLessonsJson', () => {
  it('lists the lessons with their misses, versioned', () => {
    expect(JSON.parse(formatLessonsJson({ lessons: [LESSON], hidden: 0 }))).toEqual({
      schemaVersion: 1,
      lessons: [
        {
          id: 7,
          repo: 'acme/shop',
          state: 'pending',
          rule: 'Validate request bodies at the edge.\nReturn 400 on a bad body.',
          scope: ['src/api/**', 'src/db/**'],
          provider: 'claude',
          model: 'opus',
          createdAt: '2026-11-04T10:00:00.000Z',
          decidedAt: null,
          misses: [
            {
              id: 1,
              number: 3,
              file: 'src/api/orders.ts',
              line: 22,
              author: 'alice',
              role: 'member',
              threadUrl: 'https://github.com/acme/shop/pull/3#discussion_r1',
            },
            {
              id: 2,
              number: 4,
              file: 'src/db/pool.ts',
              line: 9,
              author: 'alice',
              role: 'member',
              threadUrl: null,
            },
          ],
        },
      ],
    })
  })
})
