import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { selectFindings, summarizeFiles } from './select-findings.js'

describe('selectFindings', () => {
  it('shows findings at confidence 80 or more and counts the rest by reason', () => {
    const findings = [49, 50, 79, 80, 100].map((confidence) => findingFixture({ confidence }))

    const selection = selectFindings(findings)

    expect(selection.findings.map(({ confidence }) => confidence)).toEqual([100, 80])
    expect(selection.belowFloor).toBe(1)
    expect(selection.belowCut).toBe(2)
  })

  it('orders by severity, then confidence, then file, then line', () => {
    const findings = [
      findingFixture({ severity: 'P2', confidence: 100, file: 'a.ts', line: 1 }),
      findingFixture({ severity: 'P1', confidence: 85, file: 'a.ts', line: 1 }),
      findingFixture({ severity: 'P1', confidence: 95, file: 'b.ts', line: 9 }),
      findingFixture({ severity: 'P1', confidence: 95, file: 'a.ts', line: 7 }),
      findingFixture({ severity: 'P1', confidence: 95, file: 'a.ts', line: 3 }),
      findingFixture({ severity: 'P0', confidence: 80, file: 'z.ts', line: 1 }),
    ]

    const ordered = selectFindings(findings).findings

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

    selectFindings(findings)

    expect(findings.map(({ severity }) => severity)).toEqual(['P2', 'P0'])
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
      ),
    ).toEqual([{ path: 'a.ts', change: 'First', findings: 0 }])
  })

  it('adds files that only appear in findings, without a description', () => {
    expect(summarizeFiles([], [findingFixture({ file: 'src/x.ts' })])).toEqual([
      { path: 'src/x.ts', change: '', findings: 1 },
    ])
  })
})
