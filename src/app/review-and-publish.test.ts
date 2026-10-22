import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { reviewReportJson } from '../../test/support/review-report.js'
import type { ContextSources } from '../context/types.js'
import type { PullRequestReviewState } from '../github/pull-request-reviews.js'
import type { PullRequest } from '../github/pull-request.js'
import type { ReviewProvider } from '../providers/types.js'
import { FINDING_MARKER, resolvedMarker, reviewMarker } from '../publish/markers.js'
import { RECHECK_JSON_SCHEMA } from '../review/recheck-schema.js'
import { diffFingerprint } from '../review/diff-fingerprint.js'
import { reviewAndPublish } from './review-and-publish.js'
import type { ReviewAndPublishDeps, ReviewAndPublishInput } from './review-and-publish.js'
import type { PullRequestReviewDeps } from './review-pull-request.js'

const PR = pullRequestFixture()
const REF = { owner: 'acme', repo: 'shop', number: 12 }
const URL = 'https://github.com/acme/shop/pull/12#pullrequestreview-9'
const REPORT = reviewReportJson({ findings: [findingFixture({ line: 3, confidence: 95 })] })

const SOURCES: ContextSources = {
  readTree: async () => ({ entries: [], truncated: false }),
  readRepoFile: async () => null,
  readLocalFile: async () => null,
  listLocalDocs: async () => null,
}

function state(
  options: { reviewedHead?: boolean; resolved?: boolean } = {},
): PullRequestReviewState {
  return {
    viewer: 'octocat',
    pullState: 'open',
    reviews: options.reviewedHead
      ? [
          {
            id: 'R1',
            author: 'octocat',
            body: `Review\n\n${reviewMarker({ sha: PR.headSha, findings: 1 })}`,
            commitSha: PR.headSha,
          },
        ]
      : [],
    threads: options.reviewedHead
      ? [
          {
            id: 'T1',
            isResolved: options.resolved ?? false,
            isOutdated: false,
            path: 'src/other.ts',
            line: 90,
            author: 'octocat',
            body: `**P1** · Old · confidence 90\n\nWhy.\n\n${FINDING_MARKER}`,
            reviewId: 'R1',
            url: '',
            negativeReactions: 0,
            replies: [],
          },
        ]
      : [],
  }
}

const OLD = '0'.repeat(40)
const OLD_THREAD_BODY = `**P1** · Spend has no auth · confidence 90\n\nWhy.\n\n${FINDING_MARKER}`

function earlierComments(
  threads: { id: string; path?: string; title?: string }[] = [{ id: 'T1' }],
): () => Promise<PullRequestReviewState> {
  return async () => ({
    viewer: 'octocat',
    pullState: 'open',
    reviews: [
      {
        id: 'R0',
        author: 'octocat',
        body: reviewMarker({ sha: OLD, findings: threads.length }),
        commitSha: OLD,
      },
    ],
    threads: threads.map(({ id, path = 'src/shop.ts', title }) => ({
      id,
      isResolved: false,
      isOutdated: false,
      path,
      line: 3,
      author: 'octocat',
      body:
        title === undefined
          ? OLD_THREAD_BODY
          : `**P1** · ${title} · confidence 90\n\nWhy.\n\n${FINDING_MARKER}`,
      reviewId: 'R0',
      url: '',
      negativeReactions: 0,
      replies: [],
    })),
  })
}

function verdicts(...items: { id: number; verdict: string }[]): string {
  return JSON.stringify({ verdicts: items.map((item) => ({ ...item, reason: 'Checked.' })) })
}

function setup(
  overrides: Partial<ReviewAndPublishDeps> = {},
  pullRequest: PullRequest = PR,
  recheckAnswer: () => Promise<string> = async () => verdicts({ id: 1, verdict: 'fixed' }),
) {
  const calls = {
    reviews: 0,
    posts: [] as string[],
    events: [] as string[],
    log: [] as string[],
    rechecks: [] as string[],
    replies: [] as string[],
    warnings: [] as string[],
  }
  const provider: ReviewProvider = {
    id: 'fake',
    review: async (prompt) => {
      if (prompt.outputSchema === RECHECK_JSON_SCHEMA) {
        calls.log.push('recheck')
        calls.rechecks.push(prompt.data)
        return { text: await recheckAnswer(), durationMs: 3 }
      }
      calls.reviews += 1
      calls.log.push('review')
      return { text: REPORT, durationMs: 5 }
    },
  }
  const reviewDeps = (): PullRequestReviewDeps => ({
    contextSources: SOURCES,
    openMirror: () => Promise.reject(new Error('no mirror in this test')),
    openIndexStore: () => Promise.reject(new Error('no index in this test')),
    openObservedStore: () => Promise.reject(new Error('no observed store in this test')),
    extractor: { extract: async () => 'timeout', close: () => undefined } as never,
    now: () => 0,
    createProvider: () => provider,
    events: {
      contextLoaded: () => undefined,
      warning: (message) => calls.warnings.push(message),
      indexing: () => undefined,
      indexed: () => undefined,
      impactReady: () => undefined,
      relatedReady: () => undefined,
    },
  })
  const deps: ReviewAndPublishDeps = {
    fetchPullRequest: async () => pullRequest,
    fetchReviewState: async () => state(),
    reviewDeps,
    render: {
      review: (result, plan) => ({
        body: `body ${result.findings.length}`,
        comments: plan.comments.map((finding) => ({
          path: finding.file,
          line: finding.line,
          body: finding.title,
        })),
      }),
      ignoredOnly: (headSha, _ignored, _language, diff) => ({
        body: `ignored ${headSha} ${diff}`,
        comments: [],
      }),
      resolvedReply: (headSha, reason) => `Fixed in ${headSha.slice(0, 7)}: ${reason}`,
    },
    createReview: async (_pull, rendered) => {
      calls.log.push('post')
      calls.posts.push(rendered.body)
      return { url: URL }
    },
    compare: async () => {
      calls.log.push('compare')
      return [{ path: 'src/shop.ts', status: 'modified', patch: '@@ -3 +3 @@\n-a\n+b' }]
    },
    replyAndResolve: async (threadId, body) => {
      calls.log.push(`resolve ${threadId}`)
      calls.replies.push(body)
    },
    events: {
      fetched: () => calls.events.push('fetched'),
      reviewed: () => calls.events.push('reviewed'),
      publishing: () => calls.events.push('publishing'),
      warning: (message) => calls.events.push(`warning: ${message}`),
    },
    ...overrides,
  }
  return { deps, calls }
}

const INPUT: ReviewAndPublishInput = {
  ref: REF,
  mode: 'manual',
  force: false,
  dryRun: false,
  publish: true,
  options: { investigate: false, verify: false },
  userLayers: [],
  userMcpServers: [],
}

describe('reviewAndPublish', () => {
  it('reviews and publishes a pull request', async () => {
    const { deps, calls } = setup()

    const run = await reviewAndPublish(INPUT, deps)

    expect(run).toMatchObject({
      status: 'reviewed',
      publication: { status: 'published', url: URL },
    })
    expect(calls.posts).toEqual(['body 1'])
    expect(calls.events).toEqual(['fetched', 'reviewed', 'publishing'])
  })

  it('skips a commit Phada reviewed with threads still open, without calling the AI', async () => {
    const { deps, calls } = setup({ fetchReviewState: async () => state({ reviewedHead: true }) })

    const run = await reviewAndPublish(INPUT, deps)

    expect(run).toEqual({
      status: 'skipped',
      pullRequest: PR,
      reason: { kind: 'open-threads', openThreads: 1 },
    })
    expect(calls.reviews).toBe(0)
  })

  it('skips in watch mode any commit Phada already reviewed, even with every thread resolved', async () => {
    const reviewed = async () => state({ reviewedHead: true, resolved: true })
    const { deps, calls } = setup({ fetchReviewState: reviewed })

    expect(await reviewAndPublish({ ...INPUT, mode: 'watch' }, deps)).toMatchObject({
      status: 'skipped',
      reason: { kind: 'already-reviewed' },
    })
    expect(await reviewAndPublish(INPUT, deps)).toMatchObject({ status: 'reviewed' })
    expect(calls.reviews).toBe(1)
  })

  describe('same diff', () => {
    const OLD = '0'.repeat(40)
    const reviewedBefore = async (): Promise<PullRequestReviewState> => ({
      viewer: 'octocat',
      pullState: 'open',
      reviews: [
        {
          id: 'R0',
          author: 'octocat',
          body: reviewMarker({ sha: OLD, findings: 1, diff: diffFingerprint(PR.diff) }),
          commitSha: OLD,
        },
      ],
      threads: [],
    })

    it('skips a new commit whose filtered diff did not change, without calling the AI', async () => {
      const { deps, calls } = setup({ fetchReviewState: reviewedBefore })

      expect(await reviewAndPublish(INPUT, deps)).toEqual({
        status: 'skipped',
        pullRequest: PR,
        reason: { kind: 'same-diff', since: OLD },
      })
      expect(calls.reviews).toBe(0)
    })

    it('reviews it with --force and keeps the fingerprint for the marker', async () => {
      const { deps, calls } = setup({ fetchReviewState: reviewedBefore })

      const run = await reviewAndPublish({ ...INPUT, force: true }, deps)

      expect(calls.reviews).toBe(1)
      expect(run.status === 'reviewed' && run.reviewed.outcome).toMatchObject({
        result: { target: { diffFingerprint: diffFingerprint(PR.diff) } },
      })
    })
  })

  describe('earlier comments', () => {
    it('rechecks them before the review and resolves the fixed one before posting', async () => {
      const { deps, calls } = setup({ fetchReviewState: earlierComments() })

      const run = await reviewAndPublish(INPUT, deps)

      expect(calls.log).toEqual(['compare', 'recheck', 'review', 'resolve T1', 'post'])
      expect(calls.rechecks[0]).toContain('--- src/shop.ts\n@@ -3 +3 @@\n-a\n+b')
      expect(calls.replies).toEqual([
        `Fixed in ${PR.headSha.slice(0, 7)}: Checked.\n\n${resolvedMarker(PR.headSha)}`,
      ])
      expect(run).toMatchObject({
        status: 'reviewed',
        reviewed: { recheck: { threads: 1, fixed: 1 } },
        publication: { status: 'published', resolved: { resolved: 1, failed: 0, total: 1 } },
      })
    })

    it('leaves the comments still valid or unsure open', async () => {
      const threads = [{ id: 'T1' }, { id: 'T2', title: 'Other' }]
      const { deps, calls } = setup({ fetchReviewState: earlierComments(threads) }, PR, async () =>
        verdicts({ id: 1, verdict: 'still-valid' }, { id: 2, verdict: 'unsure' }),
      )

      const run = await reviewAndPublish(INPUT, deps)

      expect(calls.replies).toEqual([])
      expect(run).toMatchObject({ publication: { resolved: { resolved: 0, total: 0 } } })
    })

    it('compare failure without the repository tools leaves the comment unsure, without the AI', async () => {
      const { deps, calls } = setup({
        fetchReviewState: earlierComments(),
        compare: () => Promise.reject(new Error('gone')),
      })

      const run = await reviewAndPublish(INPUT, deps)

      expect(calls.rechecks).toEqual([])
      expect(calls.replies).toEqual([])
      expect(run).toMatchObject({
        reviewed: { recheck: { unsure: 1, verdicts: [{ verdict: 'unsure', by: 'no-access' }] } },
      })
    })

    it('does not send to the AI a comment whose file did not change', async () => {
      const { deps, calls } = setup({
        fetchReviewState: earlierComments([{ id: 'T1', path: 'src/other.ts' }]),
      })

      const run = await reviewAndPublish(INPUT, deps)

      expect(calls.rechecks).toEqual([])
      expect(run).toMatchObject({ reviewed: { recheck: { threads: 1, stillValid: 1 } } })
    })

    it('keeps resolving and still posts when one thread fails', async () => {
      const threads = [{ id: 'T1' }, { id: 'T2', title: 'Other' }]
      const { deps, calls } = setup(
        {
          fetchReviewState: earlierComments(threads),
          replyAndResolve: async (threadId) => {
            if (threadId === 'T1') throw new Error('no permission')
            calls.log.push(`resolve ${threadId}`)
          },
        },
        PR,
        async () => verdicts({ id: 1, verdict: 'fixed' }, { id: 2, verdict: 'fixed' }),
      )

      const run = await reviewAndPublish(INPUT, deps)

      expect(calls.log.slice(-2)).toEqual(['resolve T2', 'post'])
      expect(calls.events).toContain('warning: Could not resolve a fixed comment: no permission')
      expect(run).toMatchObject({
        publication: { status: 'published', resolved: { resolved: 1, failed: 1, total: 2 } },
      })
    })

    it('resolves nothing when the pull request moved on, on a dry run or without publishing', async () => {
      const moved = setup({
        fetchReviewState: earlierComments(),
        checkHead: async () => ({ superseded: 'f'.repeat(40) }),
      })
      const dry = setup({ fetchReviewState: earlierComments() })
      const off = setup({ fetchReviewState: earlierComments() })

      await reviewAndPublish(INPUT, moved.deps)
      const dryRun = await reviewAndPublish({ ...INPUT, dryRun: true }, dry.deps)
      await reviewAndPublish({ ...INPUT, publish: false }, off.deps)

      expect([moved.calls.replies, dry.calls.replies, off.calls.replies]).toEqual([[], [], []])
      expect(dryRun).toMatchObject({
        publication: { status: 'dry-run', wouldResolve: [{ threadId: 'T1', verdict: 'fixed' }] },
      })
    })

    it('does not recheck when resolving threads is turned off', async () => {
      const { deps, calls } = setup({ fetchReviewState: earlierComments() })

      await reviewAndPublish(
        { ...INPUT, options: { ...INPUT.options, resolveThreads: false } },
        deps,
      )

      expect(calls.log).toEqual(['review', 'post'])
    })

    it('does not post again a finding of a comment found fixed in this run', async () => {
      const { deps } = setup({
        fetchReviewState: earlierComments([{ id: 'T1', title: 'spend has no auth' }]),
      })

      const run = await reviewAndPublish(INPUT, deps)

      expect(run.status === 'reviewed' && run.plan).toMatchObject({
        comments: [],
        fixedAgain: [{ title: 'spend has no auth' }],
        fixedThreads: 1,
      })
    })

    it('reviews without resolving anything when the recheck fails', async () => {
      const { deps, calls } = setup({ fetchReviewState: earlierComments() }, PR, async () => 'nope')

      const run = await reviewAndPublish(INPUT, deps)

      expect(calls.warnings).toEqual([
        'Earlier comments were not rechecked: The AI did not return a valid review (no verdicts in the recheck).',
      ])
      expect(calls.replies).toEqual([])
      expect(run).toMatchObject({ status: 'reviewed', publication: { status: 'published' } })
    })
  })

  it('keeps the review without publishing it when publishing is off', async () => {
    const { deps, calls } = setup()

    const run = await reviewAndPublish({ ...INPUT, publish: false }, deps)

    expect(run).toMatchObject({ status: 'reviewed', publication: { status: 'not-published' } })
    expect(calls.posts).toEqual([])
  })

  it('does not publish on a dry run and says what would be skipped', async () => {
    const { deps, calls } = setup({ fetchReviewState: async () => state({ reviewedHead: true }) })

    const run = await reviewAndPublish({ ...INPUT, dryRun: true }, deps)

    expect(run).toMatchObject({
      status: 'reviewed',
      publication: { status: 'dry-run' },
      wouldSkip: { kind: 'open-threads', openThreads: 1 },
    })
    expect(calls.posts).toEqual([])
  })

  it('does not publish a review whose pull request moved to a newer commit', async () => {
    const { deps, calls } = setup({ checkHead: async () => ({ superseded: 'f'.repeat(40) }) })

    const run = await reviewAndPublish({ ...INPUT, mode: 'watch' }, deps)

    expect(run).toMatchObject({
      status: 'reviewed',
      publication: { status: 'superseded', headSha: 'f'.repeat(40) },
    })
    expect(calls.posts).toEqual([])
  })

  it('does not publish a review whose pull request was closed meanwhile', async () => {
    const { deps, calls } = setup({ checkHead: async () => 'closed-or-draft' })

    expect(await reviewAndPublish(INPUT, deps)).toMatchObject({
      publication: { status: 'closed-or-draft' },
    })
    expect(calls.posts).toEqual([])
  })

  it('returns a failed publication instead of throwing', async () => {
    const error = new Error('GitHub said no')
    const { deps } = setup({ createReview: () => Promise.reject(error) })

    expect(await reviewAndPublish(INPUT, deps)).toMatchObject({
      status: 'reviewed',
      publication: { status: 'failed', error },
    })
  })

  it('publishes the note of a pull request that only changes ignored files', async () => {
    const lockfile = pullRequestFixture({
      diff: [
        'diff --git a/package-lock.json b/package-lock.json',
        '--- a/package-lock.json',
        '+++ b/package-lock.json',
        '@@ -1 +1 @@',
        '-{}',
        '+{ }',
        '',
      ].join('\n'),
    })
    const { deps, calls } = setup({}, lockfile)

    const run = await reviewAndPublish(INPUT, deps)

    expect(run).toMatchObject({ status: 'nothing', publication: { status: 'published', url: URL } })
    expect(calls.posts).toEqual([`ignored ${PR.headSha} ${diffFingerprint('')}`])
    expect(calls.reviews).toBe(0)
  })

  it.each([
    ['closed', pullRequestFixture({ state: 'closed' })],
    ['back to draft', pullRequestFixture({ draft: true })],
  ])('skips in watch mode a pull request that is %s', async (_case, pullRequest) => {
    const { deps, calls } = setup({}, pullRequest)

    expect(await reviewAndPublish({ ...INPUT, mode: 'watch' }, deps)).toMatchObject({
      status: 'skipped',
      reason: { kind: 'closed-or-draft' },
    })
    expect(calls.reviews).toBe(0)
  })

  it('returns a failed publication when checking the head fails after the review', async () => {
    const error = new Error('GitHub 502')
    const { deps, calls } = setup({ checkHead: () => Promise.reject(error) })

    expect(await reviewAndPublish({ ...INPUT, mode: 'watch' }, deps)).toMatchObject({
      status: 'reviewed',
      publication: { status: 'failed', error },
    })
    expect(calls.reviews).toBe(1)
  })
})
