import { describe, expect, it } from 'vitest'
import type {
  PublishedReview,
  PullRequestReviewState,
  ReviewThread,
} from '../github/pull-request-reviews.js'
import { FINDING_MARKER, resolvedMarker, reviewMarker } from './markers.js'
import { threadsToRecheck, withChanges } from './recheck-candidates.js'

const HEAD = 'f'.repeat(40)
const OLD = '0'.repeat(40)
const BODY = `**P1** · Spend has no auth · confidence 90\n\nWhy.\n\n${FINDING_MARKER}`

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 'T1',
    isResolved: false,
    path: 'src/shop.ts',
    line: 10,
    author: 'me',
    body: BODY,
    reviewId: 'R1',
    replies: [],
    ...overrides,
  }
}

function review(id: string, sha: string | null, markerSha = sha ?? OLD): PublishedReview {
  return { id, author: 'me', body: reviewMarker({ sha: markerSha, findings: 1 }), commitSha: sha }
}

function state(threads: ReviewThread[], reviews = [review('R1', OLD)]): PullRequestReviewState {
  return { viewer: 'me', reviews, threads }
}

describe('threadsToRecheck', () => {
  it('takes the open Phada threads of an older commit with the commit of their review', () => {
    const threads = [
      thread(),
      thread({ id: 'T2', isResolved: true }),
      thread({ id: 'T3', author: 'mallory' }),
      thread({ id: 'T4', body: 'A human comment' }),
    ]

    expect(threadsToRecheck(state(threads), HEAD)).toEqual([
      { thread: threads[0], reviewedSha: OLD },
    ])
  })

  it('leaves out a thread a person reopened after Phada resolved it', () => {
    const reopened = thread({
      replies: [{ author: 'me', body: `Fixed in \`0000000\`: ok.\n\n${resolvedMarker(OLD)}` }],
    })
    const quotedByOther = thread({
      id: 'T2',
      replies: [{ author: 'mallory', body: `Fixed\n\n${resolvedMarker(OLD)}` }],
    })

    expect(threadsToRecheck(state([reopened, quotedByOther]), HEAD)).toEqual([
      { thread: quotedByOther, reviewedSha: OLD },
    ])
  })

  it('leaves out the threads of a review of the head', () => {
    expect(threadsToRecheck(state([thread()], [review('R1', HEAD)]), HEAD)).toEqual([])
  })

  it('takes the commit from the marker when the review has none, and null when unknown', () => {
    const fromMarker = state([thread()], [review('R1', null, OLD)])
    const unknown = state([thread({ reviewId: null })])

    expect(threadsToRecheck(fromMarker, HEAD)[0]?.reviewedSha).toBe(OLD)
    expect(threadsToRecheck(unknown, HEAD)[0]?.reviewedSha).toBeNull()
  })
})

describe('withChanges', () => {
  const item = { thread: thread(), reviewedSha: OLD }

  it('sends a changed file with its patch and the title of the finding', () => {
    const comparisons = new Map([[OLD, [{ path: 'src/shop.ts', status: 'modified', patch: '@@' }]]])

    expect(withChanges([item], comparisons)).toEqual([
      {
        id: 'T1',
        file: 'src/shop.ts',
        line: 10,
        title: 'Spend has no auth',
        body: BODY,
        patch: '@@',
        changed: true,
      },
    ])
  })

  it('marks a file the comparison does not list as unchanged', () => {
    const comparisons = new Map([[OLD, [{ path: 'src/other.ts', status: 'modified' }]]])

    expect(withChanges([item], comparisons)[0]).toMatchObject({ changed: false })
  })

  it('matches a renamed file by its previous path', () => {
    const renamed = [{ path: 'src/store.ts', previousPath: 'src/shop.ts', status: 'renamed' }]

    expect(withChanges([item], new Map([[OLD, renamed]]))[0]).toMatchObject({ changed: true })
  })

  it('sends the thread without a patch when the comparison is unavailable or the commit unknown', () => {
    const unavailable = withChanges([item], new Map([[OLD, 'unavailable' as const]]))
    const unknown = withChanges([{ ...item, reviewedSha: null }], new Map())

    expect(unavailable[0]).toMatchObject({ changed: true })
    expect(unavailable[0]).not.toHaveProperty('patch')
    expect(unknown[0]).toMatchObject({ changed: true })
  })
})
