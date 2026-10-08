import { describe, expect, it } from 'vitest'
import { formatPublishedMessage, formatSkipMessage } from './format-publication.js'

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const URL = 'https://github.com/acme/shop/pull/12#pullrequestreview-1'

describe('formatSkipMessage', () => {
  it('says how many Phada threads are still open', () => {
    expect(formatSkipMessage(SHA, { kind: 'open-threads', openThreads: 2 })).toBe(
      'a1b2c3d already reviewed by Phada; 2 threads still open. Use --force to review again.',
    )
    expect(formatSkipMessage(SHA, { kind: 'open-threads', openThreads: 1 })).toBe(
      'a1b2c3d already reviewed by Phada; 1 thread still open. Use --force to review again.',
    )
  })

  it('says when the review found nothing', () => {
    expect(formatSkipMessage(SHA, { kind: 'nothing-found' })).toBe(
      'a1b2c3d already reviewed by Phada; nothing was found. Use --force to review again.',
    )
  })
})

describe('formatPublishedMessage', () => {
  it('counts the inline comments and the findings still open', () => {
    expect(formatPublishedMessage(URL, 3, 0)).toBe(
      `Published the review with 3 inline comments: ${URL}`,
    )
    expect(formatPublishedMessage(URL, 1, 2)).toBe(
      `Published the review with 1 inline comment: ${URL} (2 findings still open from previous reviews)`,
    )
    expect(formatPublishedMessage(URL, 0, 0)).toBe(`Published the review: ${URL}`)
  })
})
