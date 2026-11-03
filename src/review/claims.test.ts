import { describe, expect, it } from 'vitest'
import { mergeClaims } from './claims.js'
import type { Claim, ClaimVerdict } from './types.js'

const claim = (text: string, verdict: ClaimVerdict, evidence = ''): Claim => ({
  claim: text,
  verdict,
  evidence,
})

const listed = (...lists: Claim[][]) => lists.map((claims) => ({ claims, onlySettled: false }))

describe('mergeClaims', () => {
  it('keeps the claims of a single pass as they are', () => {
    const claims = [
      claim('Prevents two runs on staging', 'confirmed', 'ci.yml:4'),
      claim('Covers the empty cart', 'unverified'),
      claim('Only runs on main', 'unverified'),
    ]

    expect(mergeClaims(listed(claims))).toEqual(claims)
  })

  it('takes claims that differ in case, spacing or punctuation as one', () => {
    expect(
      mergeClaims(
        listed(
          [claim('Prevents two runs on staging.', 'confirmed', 'ci.yml:4')],
          [claim('prevents two  runs, on staging', 'contradicted', 'ci.yml:9')],
        ),
      ),
    ).toEqual([claim('prevents two  runs, on staging', 'contradicted', 'ci.yml:9')])
  })

  it('takes a claim that another one extends at a word boundary as the same claim', () => {
    expect(
      mergeClaims(
        listed(
          [claim('Retries the payment without publishing to the topics.', 'confirmed', 'pay.ts:8')],
          [
            claim(
              'Retries the payment without publishing to the topics of Pix, TED and P2P',
              'contradicted',
              'pay.ts:20',
            ),
          ],
        ),
      ),
    ).toEqual([
      claim(
        'Retries the payment without publishing to the topics of Pix, TED and P2P',
        'contradicted',
        'pay.ts:20',
      ),
    ])
  })

  it('keeps apart claims that share only the start of a word', () => {
    const claims = [
      [claim('Adds the cart totals', 'confirmed', 'cart.ts:3')],
      [claim('Adds the cart totalsByTax table', 'confirmed', 'cart.ts:9')],
    ]

    expect(mergeClaims(listed(...claims))).toEqual(claims.flat())
  })

  it('keeps apart a claim of fewer than three words that starts another', () => {
    const claims = [
      [claim('Adds tests', 'confirmed', 'a.test.ts:1')],
      [claim('Adds tests for the parser', 'confirmed', 'parser.test.ts:1')],
    ]

    expect(mergeClaims(listed(...claims))).toEqual(claims.flat())
  })

  it('keeps the verdict of the first pass when both are as strong', () => {
    expect(
      mergeClaims(
        listed(
          [claim('Covers the empty cart', 'confirmed', 'shop.test.ts:40')],
          [claim('Covers the empty cart.', 'confirmed', 'shop.test.ts:41')],
        ),
      ),
    ).toEqual([claim('Covers the empty cart', 'confirmed', 'shop.test.ts:40')])
  })

  it('leaves out the unverified claims of a later pass once an earlier one listed claims', () => {
    expect(
      mergeClaims(
        listed(
          [claim('Prevents two runs on staging', 'confirmed', 'ci.yml:4')],
          [
            claim('Only runs on main', 'unverified'),
            claim('Covers the empty cart', 'confirmed', 'shop.test.ts:40'),
          ],
        ),
      ),
    ).toEqual([
      claim('Prevents two runs on staging', 'confirmed', 'ci.yml:4'),
      claim('Covers the empty cart', 'confirmed', 'shop.test.ts:40'),
    ])
  })

  it('keeps apart the claims of a single pass that one only extends or punctuates', () => {
    const claims = [
      claim('Adds the cart totals', 'confirmed', 'cart.ts:3'),
      claim('Adds the cart totals for guests', 'unverified'),
      claim('Covers the empty cart.', 'confirmed', 'cart.test.ts:4'),
      claim('Covers the empty cart!', 'unverified'),
    ]

    expect(mergeClaims(listed(claims))).toEqual(claims)
  })

  it('keeps apart claims of different passes made only of punctuation', () => {
    const claims = [[claim('—', 'confirmed', 'a.ts:1')], [claim('!!!', 'confirmed', 'b.ts:2')]]

    expect(mergeClaims(listed(...claims))).toEqual(claims.flat())
  })

  it('merges a later claim into the kept one whatever the verdict that replaced its text', () => {
    const passes = (second: ClaimVerdict) =>
      mergeClaims(
        listed(
          [claim('Adds the retry loop', 'confirmed', 'pay.ts:1')],
          [claim('Adds the retry loop for payments', second, 'pay.ts:2')],
          [claim('Adds the retry loop for refunds', 'contradicted', 'pay.ts:3')],
        ),
      )

    expect(passes('confirmed')).toEqual([
      claim('Adds the retry loop for refunds', 'contradicted', 'pay.ts:3'),
    ])
    expect(passes('contradicted')).toEqual([
      claim('Adds the retry loop for payments', 'contradicted', 'pay.ts:2'),
    ])
  })

  it('keeps the unverified claims of a later pass after a pass that lists only settled ones', () => {
    expect(
      mergeClaims([
        {
          claims: [claim('Prevents two runs on staging', 'confirmed', 'ci.yml:4')],
          onlySettled: true,
        },
        {
          claims: [
            claim('Prevents two runs on staging', 'confirmed', 'ci.yml:5'),
            claim('Only runs on main', 'unverified'),
          ],
          onlySettled: false,
        },
      ]),
    ).toEqual([
      claim('Prevents two runs on staging', 'confirmed', 'ci.yml:4'),
      claim('Only runs on main', 'unverified'),
    ])
  })

  it('keeps the unverified claims of a later pass when no earlier pass listed any', () => {
    expect(mergeClaims(listed([], [claim('Only runs on main', 'unverified')]))).toEqual([
      claim('Only runs on main', 'unverified'),
    ])
  })
})
