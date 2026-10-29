import { describe, expect, it } from 'vitest'
import { formatClaimsSection } from './format-claims.js'

describe('formatClaimsSection', () => {
  it('lists each claim of the description with its verdict and evidence', () => {
    expect(
      formatClaimsSection([
        {
          claim: 'Prevents two runs on staging',
          verdict: 'contradicted',
          evidence: 'ci.yml:4 groups by the ref',
        },
        { claim: 'Covers the empty cart', verdict: 'confirmed', evidence: 'shop.test.ts:40' },
        { claim: 'Is backward compatible', verdict: 'unverified', evidence: '' },
      ]),
    ).toBe(
      '## Claims of the description\n\n' +
        '- contradicted: Prevents two runs on staging (ci.yml:4 groups by the ref)\n' +
        '- confirmed: Covers the empty cart (shop.test.ts:40)\n' +
        '- unverified: Is backward compatible\n',
    )
  })

  it('says when the description makes no checkable claim', () => {
    expect(formatClaimsSection([])).toBe('## Claims of the description\n\nNone.\n')
  })

  it('cleans the text of the AI before it reaches the terminal', () => {
    expect(
      formatClaimsSection([
        { claim: 'Safe\u0007\nnow', verdict: 'confirmed', evidence: 'a.ts:1\u202e' },
      ]),
    ).toBe('## Claims of the description\n\n- confirmed: Safe now (a.ts:1)\n')
  })
})
