import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { reviewVerdict } from './verdict.js'

const p = (severity: 'P0' | 'P1' | 'P2') => findingFixture({ severity })

describe('reviewVerdict', () => {
  it.each([
    ['clean', [], []],
    ['comments', [p('P2')], []],
    ['comments', [], [p('P1')]],
    ['blocking', [p('P2'), p('P1')], []],
    ['blocking', [p('P0')], [p('P2')]],
  ] as const)('is %s for findings %j and worth checking %j', (verdict, findings, worthChecking) => {
    expect(reviewVerdict({ findings, worthChecking })).toBe(verdict)
  })
})
