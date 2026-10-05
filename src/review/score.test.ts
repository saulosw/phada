import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { scoreFindings } from './score.js'
import type { Severity } from './types.js'

function findings(...severities: Severity[]) {
  return severities.map((severity, index) =>
    findingFixture({ severity, file: `src/f${index}.ts`, line: index + 1 }),
  )
}

describe('scoreFindings', () => {
  it.each([
    [[], 5],
    [['P2'], 4],
    [['P2', 'P2', 'P2'], 4],
    [['P1'], 3],
    [['P1', 'P2'], 3],
    [['P1', 'P1'], 2],
    [['P1', 'P1', 'P1', 'P2'], 2],
    [['P0'], 1],
    [['P0', 'P1', 'P1'], 1],
    [['P0', 'P0'], 0],
  ] as [Severity[], number][])('scores %j as %d', (severities, value) => {
    expect(scoreFindings(findings(...severities)).value).toBe(value)
  })

  it('says why when there is nothing to fix', () => {
    expect(scoreFindings([])).toEqual({ value: 5, reason: 'no problems found' })
  })

  it('names the findings of the highest severity that weigh on the score', () => {
    const reason = scoreFindings([
      findingFixture({ severity: 'P2', file: 'src/a.ts', line: 1 }),
      findingFixture({ severity: 'P1', file: 'api/src/routes/users.ts', line: 63 }),
      findingFixture({ severity: 'P1', file: 'api/src/routes/users.ts', line: 70 }),
    ]).reason

    expect(reason).toBe('2 P1 findings (users.ts:63, users.ts:70)')
  })

  it('uses the singular for one finding', () => {
    expect(scoreFindings(findings('P0')).reason).toBe('1 P0 finding (f0.ts:1)')
  })

  it('lists at most three locations', () => {
    expect(scoreFindings(findings('P2', 'P2', 'P2', 'P2')).reason).toBe(
      '4 P2 findings (f0.ts:1, f1.ts:2, f2.ts:3, …)',
    )
  })
})
