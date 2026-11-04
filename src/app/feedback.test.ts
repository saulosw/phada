import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { reviewState, reviewThread } from '../../test/support/review-state.js'
import type { PullRequestReviewState } from '../github/pull-request-reviews.js'
import { FINDING_MARKER, reviewMarker } from '../publish/markers.js'
import { openHistoryStore } from '../store/history-store.js'
import type { HistoryStore } from '../store/history-store.js'
import { recordReviewFeedback, refreshFeedback } from './feedback.js'
import type { FeedbackRefreshDeps } from './feedback.js'
import type { ReviewRun } from './review-and-publish.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-app-feedback-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let files = 0
const fresh = () => openHistoryStore(join(dir, `h${++files}`, 'history.sqlite'))

const PR = pullRequestFixture()
const OLD = '0'.repeat(40)
const NOW = '2026-10-22T12:00:00.000Z'

const STATE: PullRequestReviewState = reviewState({
  viewer: 'octocat',
  reviews: [
    { id: 'R0', author: 'octocat', body: reviewMarker({ sha: OLD, findings: 1 }), commitSha: OLD },
  ],
  threads: [
    reviewThread({
      id: 'T1',
      isResolved: true,
      path: 'src/old.ts',
      line: 5,
      author: 'octocat',
      body: `**P2** · Old finding · confidence 80\n\nWhy.\n\n${FINDING_MARKER}`,
      reviewId: 'R0',
    }),
  ],
})

const NEW = findingFixture({
  file: 'src/shop.ts',
  line: 3,
  title: 'Spend has no auth',
  rule: 'auth',
})

function reviewedRun(publication: { status: string }, state = STATE): ReviewRun {
  return {
    status: 'reviewed',
    pullRequest: PR,
    plan: {
      comments: [NEW],
      stillOpen: [],
      dismissed: [],
      fixedAgain: [],
      fixedThreads: 0,
      openThreads: 0,
    },
    publication,
    reviewState: state,
  } as unknown as ReviewRun
}

async function withStore(test: (store: HistoryStore) => Promise<void> | void): Promise<void> {
  const store = await fresh()
  try {
    await test(store)
  } finally {
    store.close()
  }
}

describe('recordReviewFeedback', () => {
  it('published run records the observation and the new comments as published findings', () =>
    withStore((store) => {
      const runId = store.addRun({
        source: 'manual',
        repo: PR.repo,
        number: PR.number,
        headSha: PR.headSha,
        startedAt: NOW,
        finishedAt: NOW,
        status: 'published',
        aiCalled: true,
      })

      recordReviewFeedback(store, reviewedRun({ status: 'published' }), {
        runId,
        source: 'manual',
        now: NOW,
      })

      const findings = store.findings({})
      expect(findings).toEqual([
        expect.objectContaining({
          file: 'src/old.ts',
          threadId: 'T1',
          signals: [{ kind: 'dismissed', source: 'manual', observedAt: NOW }],
        }),
        expect.objectContaining({
          repo: PR.repo,
          number: PR.number,
          commitSha: PR.headSha,
          fingerprint: 'src/shop.ts:spendhasnoauth',
          line: 3,
          severity: NEW.severity,
          confidence: NEW.confidence,
          rule: 'auth',
          runId,
          publishedAt: NOW,
          signals: [],
        }),
      ])
      expect(findings[1]?.threadId).toBeUndefined()
    }))

  it('dry run records the observation but no published findings', () =>
    withStore((store) => {
      recordReviewFeedback(store, reviewedRun({ status: 'dry-run' }), {
        source: 'manual',
        now: NOW,
      })

      expect(store.findings({}).map((finding) => finding.file)).toEqual(['src/old.ts'])
    }))

  it('skipped run records only the observation', () =>
    withStore((store) => {
      const run = {
        status: 'skipped',
        pullRequest: PR,
        reason: { kind: 'already-reviewed' },
        reviewState: STATE,
      } as ReviewRun

      recordReviewFeedback(store, run, { source: 'watch', now: NOW })

      expect(store.findings({})).toHaveLength(1)
      expect(store.feedbackDue({}, '2099-01-01T00:00:00.000Z')).toEqual([
        { repo: PR.repo, number: PR.number },
      ])
    }))

  it('run without reviewState records nothing', () =>
    withStore((store) => {
      const run = {
        status: 'skipped',
        pullRequest: PR,
        reason: { kind: 'closed-or-draft' },
      } as ReviewRun

      recordReviewFeedback(store, run, { source: 'watch', now: NOW })

      expect(store.findings({})).toEqual([])
      expect(store.feedbackDue({}, '2099-01-01T00:00:00.000Z')).toEqual([])
    }))
})

describe('refreshFeedback', () => {
  function deps(
    store: HistoryStore,
    fetchReviewState: FeedbackRefreshDeps['fetchReviewState'],
  ): FeedbackRefreshDeps & { events: { log: string[] } & FeedbackRefreshDeps['events'] } {
    const log: string[] = []
    return {
      history: store,
      fetchReviewState,
      isNotFound: (error) => error instanceof Error && error.message === 'not found',
      isRateLimited: (error) => error instanceof Error && error.message === 'rate limited',
      now: () => NOW,
      events: {
        log,
        observed: (pull, threads) => log.push(`observed ${pull.repo}#${pull.number} ${threads}`),
        warning: (message) => log.push(`warning ${message}`),
      },
    }
  }

  it('observes each pull', () =>
    withStore(async (store) => {
      const d = deps(store, async () => STATE)

      const result = await refreshFeedback(
        [
          { repo: 'acme/shop', number: 1 },
          { repo: 'acme/shop', number: 2 },
        ],
        'refresh',
        d,
      )

      expect(result).toEqual({ observed: 2, failed: 0 })
      expect(d.events.log).toEqual(['observed acme/shop#1 1', 'observed acme/shop#2 1'])
      expect(store.findings({ number: 1 })[0]?.signals[0]?.source).toBe('refresh')
    }))

  describe('harvesting the misses', () => {
    const REVIEWED = 'a'.repeat(40)
    const RUN_AT = '2026-10-20T10:00:00.000Z'
    const person = reviewThread({
      id: 'T9',
      path: 'src/shop.ts',
      line: null,
      originalLine: 22,
      originalCommit: 'c'.repeat(40),
      isOutdated: true,
      url: 'https://github.com/acme/shop/pull/3#discussion_r9',
      author: 'alice',
      association: 'MEMBER',
      bot: false,
      body: 'This loses the balance.',
      createdAt: '2026-10-20T11:00:00Z',
    })
    const harvested = reviewState({ viewer: 'octocat', author: 'bob', threads: [person] })

    function localRun(resultJson: string) {
      return {
        source: 'manual' as const,
        repo: 'acme/shop',
        number: 3,
        headSha: REVIEWED,
        startedAt: RUN_AT,
        finishedAt: RUN_AT,
        status: 'dry-run' as const,
        aiCalled: true,
        provider: 'claude',
        findings: 0,
        resultJson,
      }
    }

    function counting(store: HistoryStore, state: PullRequestReviewState) {
      const counts: number[] = []
      const d = deps(store, async () => state)
      return {
        counts,
        deps: {
          ...d,
          events: {
            ...d.events,
            observed: (_pull: unknown, _threads: number, misses: number) => counts.push(misses),
          },
        },
      }
    }

    it('records a person’s thread after a local dry run as a miss and reports only the new ones', () =>
      withStore(async (store) => {
        store.addRun(localRun('{"review":{"findings":[]}}'))
        const { counts, deps: d } = counting(store, harvested)

        await refreshFeedback([{ repo: 'acme/shop', number: 3 }], 'refresh', d)
        await refreshFeedback([{ repo: 'acme/shop', number: 3 }], 'refresh', d)

        expect(counts).toEqual([1, 0])
        expect(store.misses({}).misses).toMatchObject([
          {
            repo: 'acme/shop',
            number: 3,
            reviewedSha: REVIEWED,
            commitSha: 'c'.repeat(40),
            threadId: 'T9',
            line: 22,
            author: 'alice',
            role: 'member',
            state: 'open',
            harvestedAt: NOW,
          },
        ])
      }))

    it('a finding the local run kept near the thread is not a miss', () =>
      withStore(async (store) => {
        store.addRun(
          localRun(JSON.stringify({ review: { findings: [{ file: 'src/shop.ts', line: 20 }] } })),
        )
        const { counts, deps: d } = counting(store, harvested)

        await refreshFeedback([{ repo: 'acme/shop', number: 3 }], 'refresh', d)

        expect(counts).toEqual([0])
        expect(store.misses({}).total).toBe(0)
      }))

    it('a stored review that cannot be read counts as a review without findings', () =>
      withStore(async (store) => {
        store.addRun(localRun('{not json'))
        const { counts, deps: d } = counting(store, harvested)

        await refreshFeedback([{ repo: 'acme/shop', number: 3 }], 'refresh', d)

        expect(counts).toEqual([1])
      }))
  })

  it('not found marks the pull closed and keeps going', () =>
    withStore(async (store) => {
      store.observeFeedback({
        repo: 'acme/shop',
        number: 1,
        pullState: 'open',
        observedAt: '2026-10-01T00:00:00.000Z',
        source: 'watch',
        threads: [],
      })
      store.recordPublished([
        {
          repo: 'acme/shop',
          number: 1,
          commitSha: OLD,
          fingerprint: 'a.ts:x',
          file: 'a.ts',
          line: 1,
          title: 'X',
          severity: 'P2',
          confidence: 80,
          publishedAt: NOW,
        },
      ])
      const d = deps(store, async (pull) => {
        if (pull.number === 1) throw new Error('not found')
        return STATE
      })

      const result = await refreshFeedback(
        [
          { repo: 'acme/shop', number: 1 },
          { repo: 'acme/shop', number: 2 },
        ],
        'watch',
        d,
      )

      expect(result).toEqual({ observed: 2, failed: 0 })
      expect(store.feedbackDue({ number: 1 }, '2099-01-01T00:00:00.000Z')).toEqual([])
    }))

  it('stops at a rate limit and leaves the rest for the next refresh', () =>
    withStore(async (store) => {
      const asked: number[] = []
      const d = deps(store, async (pull) => {
        asked.push(pull.number)
        throw new Error('rate limited')
      })

      const result = await refreshFeedback(
        [
          { repo: 'acme/shop', number: 1 },
          { repo: 'acme/shop', number: 2 },
        ],
        'watch',
        d,
      )

      expect(asked).toEqual([1])
      expect(result).toEqual({ observed: 0, failed: 2 })
      expect(d.events.log).toEqual([
        'warning acme/shop#1: rate limited; the other pull requests wait for the next refresh',
      ])
    }))

  it('stops between pull requests when asked to', () =>
    withStore(async (store) => {
      const asked: number[] = []
      const d = deps(store, async (pull) => {
        asked.push(pull.number)
        return STATE
      })

      const result = await refreshFeedback(
        [
          { repo: 'acme/shop', number: 1 },
          { repo: 'acme/shop', number: 2 },
        ],
        'watch',
        { ...d, stopRequested: () => asked.length === 1 },
      )

      expect(asked).toEqual([1])
      expect(result).toEqual({ observed: 1, failed: 0 })
    }))

  it('other errors warn and count as failed', () =>
    withStore(async (store) => {
      const d = deps(store, async () => {
        throw new Error('timeout')
      })

      const result = await refreshFeedback([{ repo: 'acme/shop', number: 1 }], 'watch', d)

      expect(result).toEqual({ observed: 0, failed: 1 })
      expect(d.events.log).toEqual(['warning acme/shop#1: timeout'])
    }))
})
