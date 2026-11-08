import { describe, expect, it } from 'vitest'
import { reviewState, reviewThread } from '../../test/support/review-state.js'
import type { ReviewThread } from '../github/pull-request-reviews.js'
import { FINDING_MARKER } from './markers.js'
import { threadFindings } from './thread-findings.js'

function phadaThread(overrides: Partial<ReviewThread> & { lines?: string[] }): ReviewThread {
  const { lines, ...rest } = overrides
  return reviewThread({
    body: [
      '**P1** · Counts instead of summing · confidence 90',
      'The total ignores the prices.',
      ...(lines ?? []),
      FINDING_MARKER,
    ].join('\n\n'),
    ...rest,
  })
}

describe('threadFindings', () => {
  it('numbers the open Phada threads by file, then line', () => {
    const state = reviewState({
      threads: [
        phadaThread({ id: 'b9', path: 'src/b.ts', line: 9 }),
        phadaThread({ id: 'a7', path: 'src/a.ts', line: 7 }),
        phadaThread({ id: 'a2', path: 'src/a.ts', line: null, isOutdated: true, originalLine: 2 }),
        phadaThread({ id: 'closed', path: 'src/a.ts', line: 1, isResolved: true }),
        phadaThread({ id: 'theirs', path: 'src/a.ts', line: 1, author: 'someone' }),
        reviewThread({ id: 'plain', path: 'src/a.ts', line: 1, body: 'A question.' }),
      ],
    })

    expect(threadFindings(state).map(({ number, thread }) => [number, thread.id])).toEqual([
      [1, 'a2'],
      [2, 'a7'],
      [3, 'b9'],
    ])
  })

  it('reads the severity and title from the first line and gives the AI the rest of the comment', () => {
    const [found] = threadFindings(
      reviewState({ threads: [phadaThread({ url: 'https://github.test/c/1', path: 'src/a.ts' })] }),
    )

    expect(found).toEqual({
      number: 1,
      thread: { id: 'T1', url: 'https://github.test/c/1', outdated: false },
      finding: {
        severity: 'P1',
        file: 'src/a.ts',
        line: 10,
        title: 'Counts instead of summing',
        why: 'The total ignores the prices.',
        fix: null,
      },
    })
  })

  it('takes the suggestion block as a replacement of the current range of the thread', () => {
    const [single, range] = threadFindings(
      reviewState({
        threads: [
          phadaThread({ path: 'a.ts', line: 3, lines: ['```suggestion\n  return sum\n```'] }),
          phadaThread({
            path: 'b.ts',
            line: 6,
            startLine: 4,
            lines: ['```suggestion\nconst a = 1\nconst b = 2\n```'],
          }),
        ],
      }),
    )

    expect(single?.finding.suggestion).toEqual({
      startLine: 3,
      endLine: 3,
      replacement: '  return sum',
    })
    expect(range?.finding.suggestion).toEqual({
      startLine: 4,
      endLine: 6,
      replacement: 'const a = 1\nconst b = 2',
    })
  })

  it('reads a longer fence around code with backticks, and an empty block as a deletion', () => {
    const [fenced, empty] = threadFindings(
      reviewState({
        threads: [
          phadaThread({
            path: 'a.ts',
            lines: ['````suggestion\nconst md = ```\n```\n````', '<sub>rule</sub>'],
          }),
          phadaThread({ path: 'b.ts', lines: ['```suggestion\n```'] }),
        ],
      }),
    )

    expect(fenced?.finding.suggestion?.replacement).toBe('const md = ```\n```')
    expect(empty?.finding.suggestion?.replacement).toBe('')
  })

  it('leaves the suggestion of an outdated thread to the AI', () => {
    const [outdated] = threadFindings(
      reviewState({
        threads: [
          phadaThread({
            line: null,
            originalLine: 5,
            isOutdated: true,
            lines: ['```suggestion\nx\n```'],
          }),
        ],
      }),
    )

    expect(outdated?.thread.outdated).toBe(true)
    expect(outdated?.finding.line).toBe(5)
    expect(outdated?.finding.suggestion).toBeUndefined()
    expect(outdated?.finding.why).toContain('```suggestion\nx\n```')
  })

  it('keeps a thread whose first line is not a Phada title, by its first line', () => {
    const [found] = threadFindings(
      reviewState({ threads: [reviewThread({ body: `Edited by hand\n\n${FINDING_MARKER}` })] }),
    )

    expect(found?.finding).toMatchObject({ title: 'Edited by hand', why: '' })
    expect(found?.finding.severity).toBeUndefined()
  })
})
