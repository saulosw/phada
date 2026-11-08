import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { numberFindings } from './finding-numbers.js'

describe('numberFindings', () => {
  it('numbers the findings by severity, then in the order the review gave them', () => {
    const style = findingFixture({ severity: 'P2', title: 'style' })
    const leak = findingFixture({ severity: 'P0', title: 'leak' })
    const race = findingFixture({ severity: 'P1', title: 'race' })
    const theft = findingFixture({ severity: 'P0', title: 'theft' })

    expect(numberFindings([style, leak, race, theft])).toEqual([
      { number: 1, finding: leak },
      { number: 2, finding: theft },
      { number: 3, finding: race },
      { number: 4, finding: style },
    ])
  })
})
