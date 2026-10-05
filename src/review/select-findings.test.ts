import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { parseDiffFiles } from './diff-lines.js'
import { selectFindings, summarizeFiles } from './select-findings.js'

function addedFile(path: string): string[] {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1,20 @@',
    ...Array.from({ length: 20 }, (_, index) => `+line ${index + 1}`),
  ]
}

const DIFF_FILES = parseDiffFiles(
  [
    ...addedFile('src/shop.ts'),
    ...addedFile('a.ts'),
    ...addedFile('b.ts'),
    ...addedFile('c.ts'),
    ...addedFile('z.ts'),
    'diff --git a/api/src/users.ts b/api/src/users.ts',
    '--- a/api/src/users.ts',
    '+++ b/api/src/users.ts',
    '@@ -10,3 +10,4 @@',
    ' a',
    '+b',
    ' c',
    ' d',
    'diff --git a/src/old.ts b/src/old.ts',
    'deleted file mode 100644',
    '--- a/src/old.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
    '',
  ].join('\n'),
)

function usersFinding(line: number, title = 'spend has no auth') {
  return findingFixture({ file: 'api/src/users.ts', line, title })
}

describe('selectFindings', () => {
  it('shows findings at confidence 80 or more and counts the rest by reason', () => {
    const findings = [49, 50, 79, 80, 100].map((confidence) =>
      findingFixture({ confidence, title: `problem ${confidence}` }),
    )

    const selection = selectFindings(findings, DIFF_FILES)

    expect(selection.findings.map(({ confidence }) => confidence)).toEqual([100, 80])
    expect(selection).toMatchObject({ belowFloor: 1, outsideDiff: 0, duplicate: 0, belowCut: 2 })
  })

  it('orders by severity, then confidence, then file, then line', () => {
    const findings = [
      findingFixture({ severity: 'P2', confidence: 100, file: 'a.ts', line: 1 }),
      findingFixture({ severity: 'P1', confidence: 85, file: 'a.ts', line: 1 }),
      findingFixture({ severity: 'P1', confidence: 95, file: 'b.ts', line: 9 }),
      findingFixture({ severity: 'P1', confidence: 95, file: 'a.ts', line: 7 }),
      findingFixture({ severity: 'P1', confidence: 95, file: 'a.ts', line: 3 }),
      findingFixture({ severity: 'P0', confidence: 80, file: 'z.ts', line: 1 }),
    ].map((finding, index) => ({ ...finding, title: `problem ${index}` }))

    const ordered = selectFindings(findings, DIFF_FILES).findings

    expect(
      ordered.map(
        ({ severity, confidence, file, line }) => `${severity} ${confidence} ${file}:${line}`,
      ),
    ).toEqual([
      'P0 80 z.ts:1',
      'P1 95 a.ts:3',
      'P1 95 a.ts:7',
      'P1 95 b.ts:9',
      'P1 85 a.ts:1',
      'P2 100 a.ts:1',
    ])
  })

  it('does not change the order of the findings it was given', () => {
    const findings = [findingFixture({ severity: 'P2' }), findingFixture({ severity: 'P0' })]

    selectFindings(findings, DIFF_FILES)

    expect(findings.map(({ severity }) => severity)).toEqual(['P2', 'P0'])
  })

  it.each([
    [10, true],
    [11, true],
    [13, true],
    [9, false],
    [14, false],
  ])('keeps a finding on line %d only if it is inside a hunk (%s)', (line, kept) => {
    const selection = selectFindings([usersFinding(line)], DIFF_FILES)

    expect(selection.findings).toHaveLength(kept ? 1 : 0)
    expect(selection.outsideDiff).toBe(kept ? 0 : 1)
  })

  it('drops findings in files the pull request does not change or deletes', () => {
    const selection = selectFindings(
      [findingFixture({ file: 'src/missing.ts' }), findingFixture({ file: 'src/old.ts' })],
      DIFF_FILES,
    )

    expect(selection.findings).toEqual([])
    expect(selection.outsideDiff).toBe(2)
  })

  it.each(['b/api/src/users.ts', './api/src/users.ts', 'users.ts', 'src/users.ts'])(
    'uses the full path of the changed file when the AI writes %s',
    (file) => {
      const [finding] = selectFindings([{ ...usersFinding(11), file }], DIFF_FILES).findings

      expect(finding?.file).toBe('api/src/users.ts')
    },
  )

  it('keeps the most severe of the same problem reported twice at the same line', () => {
    const selection = selectFindings(
      [
        { ...usersFinding(11, 'Spend has no auth'), severity: 'P2', confidence: 99 },
        { ...usersFinding(11, 'spend  has NO auth!'), severity: 'P0', confidence: 85 },
        { ...usersFinding(11, 'Spend, has no auth.'), severity: 'P1', confidence: 95 },
      ],
      DIFF_FILES,
    )

    expect(selection.findings.map(({ severity }) => severity)).toEqual(['P0'])
    expect(selection.duplicate).toBe(2)
  })

  it('keeps the copy of a repeated problem that clears the confidence cut', () => {
    const selection = selectFindings(
      [
        { ...usersFinding(11), severity: 'P0', confidence: 60 },
        { ...usersFinding(11), severity: 'P1', confidence: 95 },
      ],
      DIFF_FILES,
    )

    expect(
      selection.findings.map(({ severity, confidence }) => `${severity} ${confidence}`),
    ).toEqual(['P1 95'])
    expect(selection).toMatchObject({ duplicate: 1, belowCut: 0 })
  })

  it('keeps the more confident of two duplicates with the same severity', () => {
    const selection = selectFindings(
      [
        { ...usersFinding(11), confidence: 85 },
        { ...usersFinding(11), confidence: 95 },
      ],
      DIFF_FILES,
    )

    expect(selection.findings.map(({ confidence }) => confidence)).toEqual([95])
    expect(selection.duplicate).toBe(1)
  })

  it('keeps different problems on the same line and the same problem on different lines', () => {
    const selection = selectFindings(
      [
        usersFinding(11, 'spend has no auth'),
        usersFinding(11, 'amount can be negative'),
        usersFinding(12),
      ],
      DIFF_FILES,
    )

    expect(selection.findings).toHaveLength(3)
    expect(selection.duplicate).toBe(0)
  })

  it('counts each dropped finding once, by the first reason that applies', () => {
    const selection = selectFindings(
      [
        findingFixture({ file: 'src/missing.ts', confidence: 40, title: 'low and outside' }),
        findingFixture({ file: 'src/missing.ts', confidence: 90, title: 'outside' }),
        { ...usersFinding(11, 'twice'), confidence: 90 },
        { ...usersFinding(11, 'twice'), confidence: 60 },
        { ...usersFinding(12, 'unsure'), confidence: 70 },
      ],
      DIFF_FILES,
    )

    expect(selection).toEqual({
      findings: [{ ...usersFinding(11, 'twice'), confidence: 90 }],
      belowFloor: 1,
      outsideDiff: 1,
      duplicate: 1,
      belowCut: 1,
    })
  })
})

describe('summarizeFiles', () => {
  it('counts the shown findings per file and puts files with more findings first', () => {
    const files = summarizeFiles(
      [
        { path: 'b.ts', change: 'Changes b' },
        { path: 'a.ts', change: 'Changes a' },
        { path: 'c.ts', change: 'Changes c' },
      ],
      [
        findingFixture({ file: 'c.ts' }),
        findingFixture({ file: 'c.ts' }),
        findingFixture({ file: 'b.ts' }),
      ],
      DIFF_FILES,
    )

    expect(files).toEqual([
      { path: 'c.ts', change: 'Changes c', findings: 2 },
      { path: 'b.ts', change: 'Changes b', findings: 1 },
      { path: 'a.ts', change: 'Changes a', findings: 0 },
    ])
  })

  it('keeps the first description of a repeated path', () => {
    expect(
      summarizeFiles(
        [
          { path: 'a.ts', change: 'First' },
          { path: 'a.ts', change: 'Second' },
        ],
        [],
        DIFF_FILES,
      ),
    ).toEqual([{ path: 'a.ts', change: 'First', findings: 0 }])
  })

  it('adds files that only appear in findings, without a description', () => {
    expect(summarizeFiles([], [findingFixture({ file: 'src/shop.ts' })], DIFF_FILES)).toEqual([
      { path: 'src/shop.ts', change: '', findings: 1 },
    ])
  })

  it('lists only files of the pull request, under their full path', () => {
    expect(
      summarizeFiles(
        [
          { path: 'users.ts', change: 'Short path' },
          { path: 'docs/missing.md', change: 'Not in the diff' },
        ],
        [],
        DIFF_FILES,
      ),
    ).toEqual([{ path: 'api/src/users.ts', change: 'Short path', findings: 0 }])
  })
})
