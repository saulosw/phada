import { describe, expect, it } from 'vitest'
import type {
  PublishedReview,
  PullRequestReviewState,
  ReviewThread,
} from '../github/pull-request-reviews.js'
import { decideRun } from './decide-run.js'
import { FINDING_MARKER, reviewMarker } from './markers.js'

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const OLD = '0'.repeat(40)
const RUN = { headSha: HEAD, force: false, dryRun: false }

function review(sha: string, findings: number, author = 'me'): PublishedReview {
  return {
    id: `R${findings}`,
    author,
    body: `Body\n\n${reviewMarker({ sha, findings })}`,
    commitSha: sha,
  }
}

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    isResolved: false,
    path: 'src/shop.ts',
    line: 3,
    author: 'me',
    body: `**P1** · Title · confidence 90\n\nWhy.\n\n${FINDING_MARKER}`,
    reviewId: 'R1',
    ...overrides,
  }
}

function state(reviews: PublishedReview[], threads: ReviewThread[] = []): PullRequestReviewState {
  return { viewer: 'me', reviews, threads }
}

describe('decideRun', () => {
  it('runs when Phada never reviewed the pull request', () => {
    expect(decideRun(state([]), RUN)).toEqual({ action: 'run' })
  })

  it('runs on a new commit even with open threads from an older one', () => {
    expect(decideRun(state([review(OLD, 1)], [thread()]), RUN)).toEqual({ action: 'run' })
  })

  it('skips the same commit while any Phada thread is open, counting all of them', () => {
    const threads = [thread(), thread({ reviewId: 'old' }), thread({ isResolved: true })]

    expect(decideRun(state([review(OLD, 1), review(HEAD, 2)], threads), RUN)).toEqual({
      action: 'skip',
      reason: { kind: 'open-threads', openThreads: 2 },
    })
  })

  it('runs the same commit again once every thread is resolved', () => {
    const threads = [thread({ isResolved: true })]

    expect(decideRun(state([review(HEAD, 3)], threads), RUN)).toEqual({ action: 'run' })
  })

  it('skips the same commit when its review found nothing', () => {
    expect(decideRun(state([review(HEAD, 0)]), RUN)).toEqual({
      action: 'skip',
      reason: { kind: 'nothing-found' },
    })
  })

  it('follows the latest review of the same commit', () => {
    expect(decideRun(state([review(HEAD, 2), review(HEAD, 0)]), RUN)).toEqual({
      action: 'skip',
      reason: { kind: 'nothing-found' },
    })
    expect(decideRun(state([review(HEAD, 0), review(HEAD, 2)]), RUN)).toEqual({ action: 'run' })
  })

  it('ignores a review with the marker written by someone else', () => {
    expect(decideRun(state([review(HEAD, 0, 'mallory')]), RUN)).toEqual({ action: 'run' })
  })

  it('ignores a review of the viewer without the marker', () => {
    const plain = { ...review(HEAD, 0), body: 'Looks good' }

    expect(decideRun(state([plain]), RUN)).toEqual({ action: 'run' })
  })

  it('does not count open threads written by someone else', () => {
    const threads = [thread({ author: 'mallory' })]

    expect(decideRun(state([review(HEAD, 0)], threads), RUN)).toEqual({
      action: 'skip',
      reason: { kind: 'nothing-found' },
    })
    expect(decideRun(state([review(HEAD, 1)], threads), RUN)).toEqual({ action: 'run' })
  })

  it('does not count open threads of the viewer without the marker', () => {
    const threads = [thread({ body: 'A human comment' })]

    expect(decideRun(state([review(HEAD, 1)], threads), RUN)).toEqual({ action: 'run' })
  })

  it('never treats a deleted author as the viewer', () => {
    const ghost = { viewer: '', reviews: [review(HEAD, 0, '')], threads: [thread({ author: '' })] }

    expect(decideRun(ghost, RUN)).toEqual({ action: 'run' })
  })

  it('always runs with --force', () => {
    expect(decideRun(state([review(HEAD, 1)], [thread()]), { ...RUN, force: true })).toEqual({
      action: 'run',
    })
  })

  it('never skips with --dry-run and says what would happen', () => {
    expect(decideRun(state([review(HEAD, 1)], [thread()]), { ...RUN, dryRun: true })).toEqual({
      action: 'run',
      wouldSkip: { kind: 'open-threads', openThreads: 1 },
    })
  })

  it('reports nothing to skip with --dry-run and --force', () => {
    const options = { ...RUN, dryRun: true, force: true }

    expect(decideRun(state([review(HEAD, 0)]), options)).toEqual({ action: 'run' })
  })
})
