import { describe, expect, it } from 'vitest'
import { fit, oneLine, wrapText } from './text-fit.js'

describe('oneLine', () => {
  it('strips control and bidi characters and keeps the text on one line', () => {
    expect(oneLine('Fix\u001B[31m the\n\tcart‮  total ')).toBe('Fix[31m the cart total')
  })
})

describe('fit', () => {
  it('pads a short text and cuts a long one with an ellipsis', () => {
    expect(fit('shop', 6)).toBe('shop  ')
    expect(fit('acme/shop#12', 8)).toBe('acme/sh…')
    expect(fit('ação', 4)).toBe('ação')
    expect(fit('anything', 0)).toBe('')
  })
})

describe('wrapText', () => {
  it('wraps at spaces, keeps paragraphs and cuts a word longer than the width', () => {
    expect(wrapText('The total ignores the discount\n\nSecond one', 12)).toEqual([
      'The total',
      'ignores the',
      'discount',
      '',
      'Second one',
    ])
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
    expect(wrapText('bad\u0007 bell', 20)).toEqual(['bad bell'])
  })
})
