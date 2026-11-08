import { describe, expect, it } from 'vitest'
import type { ReviewComment } from '../github/review-comments.js'
import { replyScan } from './reply-scan.js'

const BASELINE = '2026-11-08T10:00:00Z'
const OPEN = new Set([12, 13])
const comment = (id: number, overrides: Partial<ReviewComment> = {}): ReviewComment => ({
  id,
  inReplyTo: 1,
  number: 12,
  author: 'alice',
  authorIsBot: false,
  association: 'CONTRIBUTOR',
  createdAt: `2026-11-08T12:0${id}:00Z`,
  ...overrides,
})

describe('replyScan', () => {
  it('names the open pull requests with a new reply, once each, and moves the cursor', () => {
    expect(
      replyScan([comment(3), comment(4, { number: 13 }), comment(5)], {
        baselineAt: BASELINE,
        open: OPEN,
      }),
    ).toEqual({ numbers: [12, 13], lastId: 5, since: '2026-11-08T12:05:00Z' })
  })

  it.each([
    ['a comment that opens a thread', comment(3, { inReplyTo: undefined })],
    ['a bot', comment(3, { authorIsBot: true })],
    ['a pull request the watch does not know as open', comment(3, { number: 40 })],
    ['a reply before the baseline', comment(3, { createdAt: '2026-11-08T09:00:00Z' })],
  ])('leaves out %s but moves past it', (_case, listed) => {
    expect(replyScan([listed], { baselineAt: BASELINE, open: OPEN })).toEqual({
      numbers: [],
      lastId: 3,
      since: listed.createdAt,
    })
  })

  it('skips the comments already seen and keeps the cursor when nothing is new', () => {
    expect(replyScan([comment(3)], { baselineAt: BASELINE, lastId: 3, open: OPEN })).toEqual({
      numbers: [],
      lastId: 3,
    })
  })
})
