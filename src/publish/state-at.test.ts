import { describe, expect, it } from 'vitest'
import { reviewState, reviewThread } from '../../test/support/review-state.js'
import type { PullComment, ThreadComment } from '../github/pull-request-reviews.js'
import { reviewMarker } from './markers.js'
import { commentsAt, reviewStateAt } from './state-at.js'

const AT = '2026-10-08T10:15:00Z'
const BEFORE = '2026-10-08T09:00:00Z'
const AFTER = '2026-10-08T11:00:00Z'

function reply(id: string, createdAt: string | undefined): ThreadComment {
  return {
    id,
    author: 'alice',
    body: `reply ${id}`,
    bot: false,
    ...(createdAt ? { createdAt } : {}),
  }
}

function comment(id: string, createdAt: string): PullComment {
  return { id, author: 'alice', bot: false, association: 'MEMBER', createdAt, body: id }
}

describe('reviewStateAt', () => {
  it('keeps only the reviews created up to the moment, Phada reviews included', () => {
    const state = reviewState({
      reviews: [
        { id: 'R1', author: 'alice', body: 'Looks off', commitSha: null, createdAt: BEFORE },
        { id: 'R2', author: 'alice', body: 'Exactly then', commitSha: null, createdAt: AT },
        {
          id: 'R3',
          author: 'me',
          body: reviewMarker({ sha: 'a'.repeat(40), findings: 1 }),
          commitSha: 'a'.repeat(40),
          createdAt: AFTER,
        },
        { id: 'R4', author: 'bob', body: 'No date', commitSha: null },
      ],
    })

    expect(reviewStateAt(state, AT).reviews.map(({ id }) => id)).toEqual(['R1', 'R2'])
  })

  it('places a kept thread on the line where it was written, not where it is today', () => {
    const state = reviewState({
      threads: [
        reviewThread({
          id: 'T1',
          createdAt: BEFORE,
          isOutdated: true,
          line: null,
          originalLine: 42,
        }),
        reviewThread({ id: 'T2', createdAt: BEFORE, line: 7 }),
      ],
    })

    expect(reviewStateAt(state, AT).threads.map(({ line }) => line)).toEqual([42, 7])
  })

  it('drops the threads opened after the moment and the ones without a date', () => {
    const state = reviewState({
      threads: [
        reviewThread({ id: 'T1', createdAt: BEFORE }),
        reviewThread({ id: 'T2', createdAt: AFTER }),
        reviewThread({ id: 'T3' }),
      ],
    })

    expect(reviewStateAt(state, AT).threads.map(({ id }) => id)).toEqual(['T1'])
  })

  it('shows the threads from before as open and current, with the replies from before only', () => {
    const state = reviewState({
      threads: [
        reviewThread({
          id: 'T1',
          createdAt: BEFORE,
          isResolved: true,
          isOutdated: true,
          commentId: 'C1',
          comments: 4,
          replies: [
            reply('C1', BEFORE),
            reply('C2', BEFORE),
            reply('C3', AFTER),
            reply('C4', undefined),
          ],
        }),
      ],
    })

    const [thread] = reviewStateAt(state, AT).threads

    expect(thread).toMatchObject({ isResolved: false, isOutdated: false, comments: 2 })
    expect(thread?.replies.map(({ id }) => id)).toEqual(['C1', 'C2'])
  })

  it('counts no hidden replies when every reply it read came after the moment', () => {
    const state = reviewState({
      threads: [
        reviewThread({
          id: 'T1',
          createdAt: BEFORE,
          commentId: 'C1',
          comments: 30,
          replies: [reply('C29', AFTER), reply('C30', AFTER)],
        }),
      ],
    })

    const [thread] = reviewStateAt(state, AT).threads

    expect(thread).toMatchObject({ comments: 1, replies: [] })
  })

  it('keeps the hidden replies counted when a reply read is from before the moment', () => {
    const state = reviewState({
      threads: [
        reviewThread({
          id: 'T1',
          createdAt: BEFORE,
          commentId: 'C1',
          comments: 30,
          replies: [reply('C29', BEFORE), reply('C30', AFTER)],
        }),
      ],
    })

    expect(reviewStateAt(state, AT).threads[0]?.comments).toBe(29)
  })
})

describe('commentsAt', () => {
  it('keeps the comments created up to the moment', () => {
    const comments = [comment('c1', BEFORE), comment('c2', AT), comment('c3', AFTER)]

    expect(commentsAt(comments, AT).map(({ id }) => id)).toEqual(['c1', 'c2'])
  })

  it('compares instants, not text', () => {
    expect(commentsAt([comment('c1', '2026-10-08T10:14:59.500Z')], AT)).toHaveLength(1)
    expect(commentsAt([comment('c2', '2026-10-08T10:15:00.500Z')], AT)).toHaveLength(0)
  })
})
