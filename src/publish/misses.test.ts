import { describe, expect, it } from 'vitest'
import { reviewState, reviewThread } from '../../test/support/review-state.js'
import type {
  PublishedReview,
  PullRequestReviewState,
  ReviewThread,
} from '../github/pull-request-reviews.js'
import { FINDING_MARKER, reviewMarker } from './markers.js'
import { decideMisses, isNearMiss } from './misses.js'
import type { LocalReview } from './misses.js'

const REVIEWED = 'a'.repeat(40)
const LATER = 'b'.repeat(40)
const THREAD_COMMIT = 'c'.repeat(40)
const REVIEWED_AT = '2026-10-08T10:00:00Z'
const LATER_AT = '2026-10-08T12:00:00Z'
const THREAD_AT = '2026-10-08T11:00:00Z'
const PULL = { repo: 'acme/shop', number: 3 }

function phadaReview(sha: string, createdAt: string, id = 'R1'): PublishedReview {
  return {
    id,
    author: 'me',
    body: `Review.\n\n${reviewMarker({ sha, findings: 0 })}`,
    commitSha: sha,
    createdAt,
  }
}

function personThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return reviewThread({
    id: 'T9',
    path: 'src/shop.ts',
    line: null,
    originalStartLine: 20,
    originalLine: 22,
    originalCommit: THREAD_COMMIT,
    isOutdated: true,
    url: 'https://github.com/acme/shop/pull/3#discussion_r9',
    author: 'alice',
    association: 'MEMBER',
    bot: false,
    body: 'This loses the balance when the order fails.',
    createdAt: THREAD_AT,
    ...overrides,
  })
}

function phadaThread(line: number, overrides: Partial<ReviewThread> = {}): ReviewThread {
  return reviewThread({
    id: `P${line}`,
    path: 'src/shop.ts',
    line,
    author: 'me',
    reviewId: 'R1',
    body: `**P1** · Something · confidence 90\n\nWhy.\n\n${FINDING_MARKER}`,
    createdAt: REVIEWED_AT,
    ...overrides,
  })
}

function stateWith(
  threads: ReviewThread[],
  overrides: Partial<PullRequestReviewState> = {},
): PullRequestReviewState {
  return reviewState({
    author: 'bob',
    reviews: [phadaReview(REVIEWED, REVIEWED_AT)],
    threads,
    ...overrides,
  })
}

function missesOf(state: PullRequestReviewState, localReviews: LocalReview[] = []) {
  return decideMisses({ ...PULL, state, localReviews })
}

describe('decideMisses', () => {
  it('a person’s thread, made outdated after Phada’s review, with no finding there, is a miss', () => {
    expect(missesOf(stateWith([personThread()]))).toEqual([
      {
        repo: 'acme/shop',
        number: 3,
        reviewedSha: REVIEWED,
        commitSha: THREAD_COMMIT,
        threadId: 'T9',
        threadUrl: 'https://github.com/acme/shop/pull/3#discussion_r9',
        file: 'src/shop.ts',
        startLine: 20,
        line: 22,
        author: 'alice',
        role: 'member',
        body: 'This loses the balance when the order fails.',
        createdAt: THREAD_AT,
      },
    ])
  })

  it.each([
    ['a bot', { author: 'ci-bot', bot: true }],
    ['the pull request author', { author: 'bob' }],
    ['a thread that is not outdated', { isOutdated: false }],
    ['a thread without a date', { createdAt: undefined }],
    ['a general comment without a line', { originalLine: undefined, line: null }],
    ['a deleted author', { author: '' }],
  ])('%s is not a miss', (_name, overrides: Partial<ReviewThread>) => {
    expect(missesOf(stateWith([personThread(overrides)]))).toEqual([])
  })

  it('Phada’s own thread is not a miss', () => {
    const own = phadaThread(80, { isOutdated: true, createdAt: THREAD_AT })

    expect(missesOf(stateWith([own]))).toEqual([])
  })

  it('a thread written before any Phada review is not a miss', () => {
    const early = personThread({ createdAt: '2026-10-08T09:00:00Z' })

    expect(missesOf(stateWith([early]))).toEqual([])
  })

  it('a Phada finding within 5 lines of the thread is not a miss; at 6 lines it is', () => {
    expect(missesOf(stateWith([personThread(), phadaThread(15)]))).toEqual([])
    expect(missesOf(stateWith([personThread(), phadaThread(27)]))).toEqual([])
    expect(missesOf(stateWith([personThread(), phadaThread(14)]))).toHaveLength(1)
    expect(missesOf(stateWith([personThread(), phadaThread(28)]))).toHaveLength(1)
  })

  it('a Phada finding near the line in another file does not count', () => {
    const elsewhere = phadaThread(21, { path: 'src/cart.ts' })

    expect(missesOf(stateWith([personThread(), elsewhere]))).toHaveLength(1)
  })

  it('a Phada thread opened after the person’s thread does not count', () => {
    const late = phadaThread(21, { createdAt: LATER_AT })

    expect(missesOf(stateWith([personThread(), late]))).toHaveLength(1)
  })

  it('uses the original line where the Phada thread was written', () => {
    const moved = phadaThread(90, { line: null, originalLine: 21, isOutdated: true })

    expect(missesOf(stateWith([personThread(), moved]))).toEqual([])
  })

  it('a finding of a local review before the thread counts, even when it was never published', () => {
    const local: LocalReview = {
      sha: REVIEWED,
      at: REVIEWED_AT,
      findings: [{ file: 'src/shop.ts', line: 24 }],
    }

    expect(missesOf(stateWith([personThread()], { reviews: [] }), [local])).toEqual([])
  })

  it('a local dry run with no findings is a Phada review the thread came after', () => {
    const dryRun: LocalReview = { sha: LATER, at: REVIEWED_AT, findings: [] }

    expect(missesOf(stateWith([personThread()], { reviews: [] }), [dryRun])).toMatchObject([
      { reviewedSha: LATER },
    ])
  })

  it('the review that counts is the latest Phada review before the thread', () => {
    const state = stateWith([personThread()], {
      reviews: [
        phadaReview(REVIEWED, REVIEWED_AT),
        phadaReview(LATER, LATER_AT, 'R2'),
        phadaReview('d'.repeat(40), '2026-10-08T10:30:00Z', 'R3'),
      ],
    })
    const local: LocalReview = { sha: 'e'.repeat(40), at: '2026-10-08T10:10:00Z', findings: [] }

    expect(missesOf(state, [local])).toMatchObject([{ reviewedSha: 'd'.repeat(40) }])
  })

  it('a review by someone else with a Phada marker is not a Phada review', () => {
    const forged = { ...phadaReview(REVIEWED, REVIEWED_AT), author: 'mallory' }

    expect(missesOf(stateWith([personThread()], { reviews: [forged] }))).toEqual([])
  })

  it('falls back to the reviewed commit and to the current line when GitHub has no original ones', () => {
    const thread = personThread({
      originalCommit: undefined,
      originalStartLine: undefined,
      originalLine: undefined,
      line: 30,
    })

    expect(missesOf(stateWith([thread]))).toMatchObject([
      { commitSha: REVIEWED, line: 30, reviewedSha: REVIEWED },
    ])
    expect(missesOf(stateWith([thread]))[0]).not.toHaveProperty('startLine')
  })

  it('keeps the role of a person from outside and cuts a long comment to 2 KB', () => {
    const [miss] = missesOf(
      stateWith([personThread({ association: 'NONE', body: 'x'.repeat(3000) })]),
    )

    expect(miss?.role).toBe('external')
    expect(miss?.body.startsWith('x'.repeat(2048))).toBe(true)
    expect(miss?.body).toContain('[truncated by Phada: 2048 of 3000 bytes]')
  })
})

describe('isNearMiss', () => {
  it('is near in the same file within 5 lines of the range', () => {
    const range = { file: 'a.ts', startLine: 10, line: 12 }

    expect(isNearMiss(range, { file: 'a.ts', line: 5 })).toBe(true)
    expect(isNearMiss(range, { file: 'a.ts', line: 17 })).toBe(true)
    expect(isNearMiss(range, { file: 'a.ts', line: 4 })).toBe(false)
    expect(isNearMiss(range, { file: 'a.ts', line: 18 })).toBe(false)
    expect(isNearMiss(range, { file: 'b.ts', line: 11 })).toBe(false)
    expect(isNearMiss({ file: 'a.ts', line: 12 }, { file: 'a.ts', line: 7 })).toBe(true)
  })
})
