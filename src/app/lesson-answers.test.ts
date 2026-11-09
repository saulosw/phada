import { describe, expect, it } from 'vitest'
import { parseLessons } from '../review/parse-lessons.js'
import { checkLessonAnswers } from './lesson-answers.js'

const MISSES = [
  { id: 1, file: 'src/api/orders.ts' },
  { id: 2, file: 'src/api/users.ts' },
]
const FINDINGS = [
  { id: 10, file: 'src/config/load.ts' },
  { id: 11, file: 'src/config/save.ts' },
]
const PENDING = [
  { id: 4, kind: 'check' as const },
  { id: 5, kind: 'avoid' as const },
]

const check = (lessons: unknown[]) =>
  checkLessonAnswers(parseLessons(JSON.stringify({ lessons })), {
    misses: MISSES,
    findings: FINDINGS,
    pending: PENDING,
  })

describe('checkLessonAnswers', () => {
  it('keeps an avoid lesson from sent findings, scoped by their files, and ignores its misses', () => {
    expect(
      check([
        {
          kind: 'avoid',
          rule: 'Do not ask for null checks on parsed configs.',
          scope: ['src/config/**'],
          misses: [1],
          findings: [10, 11, 99],
          extends: null,
        },
      ]),
    ).toEqual({
      created: [
        {
          kind: 'avoid',
          rule: 'Do not ask for null checks on parsed configs.',
          scope: ['src/config/**'],
          missIds: [],
          findingIds: [10, 11],
        },
      ],
      attached: [],
    })
  })

  it('never reads a miss id as a finding id, even when both tables use the same number', () => {
    const answers = parseLessons(
      JSON.stringify({
        lessons: [
          {
            kind: 'avoid',
            rule: 'A.',
            scope: ['src/**'],
            misses: [7],
            findings: [],
            extends: null,
          },
          {
            kind: 'check',
            rule: 'B.',
            scope: ['src/**'],
            misses: [],
            findings: [8],
            extends: null,
          },
        ],
      }),
    )
    expect(
      checkLessonAnswers(answers, {
        misses: [
          { id: 7, file: 'src/a.ts' },
          { id: 8, file: 'src/b.ts' },
        ],
        findings: [
          { id: 7, file: 'src/a.ts' },
          { id: 8, file: 'src/b.ts' },
        ],
        pending: [],
      }),
    ).toEqual({ created: [], attached: [] })
  })

  it('drops an avoid lesson without a sent finding and a check lesson without a sent miss', () => {
    expect(
      check([
        {
          kind: 'avoid',
          rule: 'A.',
          scope: ['src/**'],
          misses: [1, 2],
          findings: [],
          extends: null,
        },
        { kind: 'avoid', rule: 'B.', scope: ['src/**'], misses: [], findings: [99], extends: null },
        { kind: 'check', rule: 'C.', scope: ['src/**'], misses: [], findings: [10], extends: null },
      ]),
    ).toEqual({ created: [], attached: [] })
  })

  it('keeps a check lesson from sent misses and ignores its findings', () => {
    expect(
      check([
        {
          kind: 'check',
          rule: 'Validate.',
          scope: ['src/api/**'],
          misses: [1],
          findings: [10],
          extends: null,
        },
      ]).created,
    ).toEqual([
      { kind: 'check', rule: 'Validate.', scope: ['src/api/**'], missIds: [1], findingIds: [] },
    ])
  })

  it('reads a lesson without kind or findings as a check lesson', () => {
    expect(
      check([{ rule: 'Validate.', scope: ['src/api/**'], misses: [2], extends: null }]).created,
    ).toEqual([
      { kind: 'check', rule: 'Validate.', scope: ['src/api/**'], missIds: [2], findingIds: [] },
    ])
  })

  it('extends a pending lesson only of the same kind; otherwise it is a new lesson', () => {
    expect(
      check([
        { kind: 'avoid', rule: '', scope: [], misses: [], findings: [10], extends: 5 },
        { kind: 'check', rule: '', scope: [], misses: [1], findings: [], extends: 4 },
        {
          kind: 'avoid',
          rule: 'New.',
          scope: ['src/config/**'],
          misses: [],
          findings: [11],
          extends: 4,
        },
        { kind: 'check', rule: '', scope: [], misses: [2], findings: [], extends: 5 },
      ]),
    ).toEqual({
      created: [
        { kind: 'avoid', rule: 'New.', scope: ['src/config/**'], missIds: [], findingIds: [11] },
      ],
      attached: [
        { lessonId: 5, missIds: [], findingIds: [10] },
        { lessonId: 4, missIds: [1], findingIds: [] },
      ],
    })
  })
})
