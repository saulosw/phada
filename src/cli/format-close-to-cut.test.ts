import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { formatCloseToCutSection } from './format-close-to-cut.js'

describe('formatCloseToCutSection', () => {
  it('counts and lists the findings close to the cut of the review', () => {
    expect(
      formatCloseToCutSection(
        [
          findingFixture({ severity: 'P0', confidence: 95, line: 3 }),
          findingFixture({ confidence: 68, line: 7, title: 'Spends race', closeToCut: true }),
          findingFixture({ severity: 'P2', confidence: 60, line: 9, closeToCut: true }),
        ],
        60,
      ),
    ).toBe(
      '## Close to the cut\n\n' +
        '2 close to the cut: at most 10 points above the cut of 60, another run may leave them out.\n\n' +
        '- P1 · src/shop.ts:7: Spends race (confidence 68)\n' +
        '- P2 · src/shop.ts:9: spend has no auth (confidence 60)\n',
    )
  })

  it('says when no finding is close to the cut', () => {
    expect(formatCloseToCutSection([findingFixture()], 75)).toBe(
      '## Close to the cut\n\nNone: no finding is at most 10 points above the cut of 75.\n',
    )
  })

  it('cleans the text of the AI before it reaches the terminal', () => {
    expect(
      formatCloseToCutSection(
        [findingFixture({ file: 'a‮.ts', title: 'Bad\u0007\ntitle', closeToCut: true })],
        80,
      ),
    ).toContain('- P1 · a.ts:1: Bad title (confidence 90)\n')
  })
})
