import { describe, expect, it } from 'vitest'
import { reviewState, reviewThread, threadReply } from '../../test/support/review-state.js'
import type { ReviewThread } from '../github/pull-request-reviews.js'
import { destinationOf, findingFingerprint, threadFeedback } from './feedback.js'
import { FINDING_MARKER, resolvedMarker, reviewMarker } from './markers.js'

const OLD = '0'.repeat(40)
const HEAD = '1'.repeat(40)
const BODY = `**P1** · Spend has no auth · confidence 90\n\nWhy.\n\n${FINDING_MARKER}`
const FINDING_COMMENT = threadReply('me', BODY)

function phadaThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return reviewThread({
    id: 'T1',
    path: 'src/shop.ts',
    line: 12,
    url: 'https://github.com/acme/shop/pull/3#discussion_r1',
    body: BODY,
    reviewId: 'R1',
    replies: [FINDING_COMMENT],
    ...overrides,
  })
}

function feedbackOf(thread: ReviewThread, pullState: 'open' | 'closed' | 'merged' = 'open') {
  const state = reviewState({
    pullState,
    reviews: [
      { id: 'R1', author: 'me', body: reviewMarker({ sha: OLD, findings: 1 }), commitSha: OLD },
    ],
    threads: [thread],
  })
  return threadFeedback(state)[0]
}

const phadaReply = threadReply('me', `Fixed in \`1111111\`: ok.\n\n${resolvedMarker(HEAD)}`)

describe('threadFeedback', () => {
  it('resolved with Phada’s marker is fixed', () => {
    const feedback = feedbackOf(
      phadaThread({ isResolved: true, replies: [FINDING_COMMENT, phadaReply] }),
    )

    expect(feedback?.destination).toBe('fixed')
    expect(feedback?.signals).toEqual(['fixed'])
  })

  it('resolved by a person on outdated lines is fixed', () => {
    expect(feedbackOf(phadaThread({ isResolved: true, isOutdated: true }))?.destination).toBe(
      'fixed',
    )
  })

  it('resolved by a person on current lines is dismissed', () => {
    const feedback = feedbackOf(phadaThread({ isResolved: true }))

    expect(feedback?.destination).toBe('dismissed')
    expect(feedback?.signals).toEqual(['dismissed'])
  })

  it('open thread on a merged pull request is ignored', () => {
    expect(feedbackOf(phadaThread(), 'merged')?.destination).toBe('ignored')
  })

  it('open thread on a closed pull request is ignored', () => {
    expect(feedbackOf(phadaThread(), 'closed')?.signals).toEqual(['ignored'])
  })

  it('open outdated thread on a merged pull request is ignored and outdated', () => {
    const feedback = feedbackOf(phadaThread({ isOutdated: true }), 'merged')

    expect(feedback).toMatchObject({ destination: 'ignored', outdated: true })
  })

  it('open thread on an open pull request is open with no destination signal', () => {
    const feedback = feedbackOf(phadaThread())

    expect(feedback?.destination).toBe('open')
    expect(feedback?.signals).toEqual([])
  })

  it('a resolved thread on a merged pull request keeps its destination', () => {
    expect(feedbackOf(phadaThread({ isResolved: true }), 'merged')?.destination).toBe('dismissed')
  })

  it('thumbs down or confused marks negative-reaction', () => {
    expect(feedbackOf(phadaThread({ negativeReactions: 1 }))?.signals).toEqual([
      'negative-reaction',
    ])
  })

  it('a reply from someone marks human-reply', () => {
    const replies = [FINDING_COMMENT, threadReply('octocat', 'Not a bug, the caller checks it.')]

    expect(feedbackOf(phadaThread({ replies }))?.signals).toEqual(['human-reply'])
  })

  it('the finding comment itself, Phada’s resolved reply and bot replies are not human replies', () => {
    const replies = [FINDING_COMMENT, phadaReply, threadReply('ci-bot', 'Deployed.', true)]

    expect(feedbackOf(phadaThread({ replies }))?.signals).toEqual([])
  })

  it('the token owner replying without a marker is a human reply', () => {
    const replies = [FINDING_COMMENT, threadReply('me', 'Will fix in a follow-up.')]

    expect(feedbackOf(phadaThread({ replies }))?.signals).toEqual(['human-reply'])
  })

  it('lists the destination before the marks', () => {
    const thread = phadaThread({
      isResolved: true,
      negativeReactions: 2,
      replies: [FINDING_COMMENT, threadReply('octocat', 'Wrong.')],
    })

    expect(feedbackOf(thread)?.signals).toEqual(['dismissed', 'negative-reaction', 'human-reply'])
  })

  it('threads by others or without the finding marker are left out', () => {
    const state = reviewState({
      threads: [
        phadaThread({ id: 'T1', author: 'mallory' }),
        phadaThread({ id: 'T2', body: 'A human comment' }),
        phadaThread({ id: 'T3', author: '' }),
      ],
    })

    expect(threadFeedback(state)).toEqual([])
  })

  it('severity and title come from the comment, commit from its review', () => {
    expect(feedbackOf(phadaThread())).toEqual({
      threadId: 'T1',
      fingerprint: findingFingerprint('src/shop.ts', 'Spend has no auth'),
      url: 'https://github.com/acme/shop/pull/3#discussion_r1',
      file: 'src/shop.ts',
      line: 12,
      title: 'Spend has no auth',
      severity: 'P1',
      commitSha: OLD,
      outdated: false,
      destination: 'open',
      signals: [],
    })
  })

  it('a comment without the usual title keeps the file as title and no severity', () => {
    const feedback = feedbackOf(phadaThread({ body: `Odd body\n\n${FINDING_MARKER}` }))

    expect(feedback).toMatchObject({ title: 'src/shop.ts' })
    expect(feedback?.severity).toBeUndefined()
  })

  it('a thread whose review is unknown has no commit', () => {
    expect(feedbackOf(phadaThread({ reviewId: 'gone' }))?.commitSha).toBeNull()
  })
})

describe('destinationOf', () => {
  it('prefers fixed over ignored', () => {
    expect(destinationOf(['ignored', 'negative-reaction', 'fixed'])).toBe('fixed')
  })

  it('is open without a destination signal', () => {
    expect(destinationOf(['human-reply'])).toBe('open')
  })
})

describe('findingFingerprint', () => {
  it('ignores case and punctuation of the title but not the file', () => {
    expect(findingFingerprint('a.ts', 'Null check!')).toBe(findingFingerprint('a.ts', 'null CHECK'))
    expect(findingFingerprint('a.ts', 'Null check')).not.toBe(
      findingFingerprint('b.ts', 'Null check'),
    )
    expect(findingFingerprint('a.ts', 'Null check')).toBe('a.ts:nullcheck')
  })
})
