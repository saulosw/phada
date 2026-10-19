import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { reviewReportJson } from '../../test/support/review-report.js'
import type { ContextSources } from '../context/types.js'
import type { PullRequestReviewState } from '../github/pull-request-reviews.js'
import type { PullRequest } from '../github/pull-request.js'
import type { ReviewProvider } from '../providers/types.js'
import { FINDING_MARKER, reviewMarker } from '../publish/markers.js'
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
            isResolved: options.resolved ?? false,
            path: 'src/other.ts',
            line: 90,
            author: 'octocat',
            body: `**P1** · Old · confidence 90\n\nWhy.\n\n${FINDING_MARKER}`,
            reviewId: 'R1',
          },
        ]
      : [],
  }
}

function setup(overrides: Partial<ReviewAndPublishDeps> = {}, pullRequest: PullRequest = PR) {
  const calls = { reviews: 0, posts: [] as string[], events: [] as string[] }
  const provider: ReviewProvider = {
    id: 'fake',
    review: async () => {
      calls.reviews += 1
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
      warning: () => undefined,
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
      ignoredOnly: (headSha) => ({ body: `ignored ${headSha}`, comments: [] }),
    },
    createReview: async (_pull, rendered) => {
      calls.posts.push(rendered.body)
      return { url: URL }
    },
    events: {
      fetched: () => calls.events.push('fetched'),
      reviewed: () => calls.events.push('reviewed'),
      publishing: () => calls.events.push('publishing'),
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
    const { deps, calls } = setup({ checkHead: async () => 'closed' })

    expect(await reviewAndPublish(INPUT, deps)).toMatchObject({
      publication: { status: 'closed' },
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
    expect(calls.posts).toEqual([`ignored ${PR.headSha}`])
    expect(calls.reviews).toBe(0)
  })

  it.each([
    ['closed', pullRequestFixture({ state: 'closed' })],
    ['back to draft', pullRequestFixture({ draft: true })],
  ])('skips in watch mode a pull request that is %s', async (_case, pullRequest) => {
    const { deps, calls } = setup({}, pullRequest)

    expect(await reviewAndPublish({ ...INPUT, mode: 'watch' }, deps)).toMatchObject({
      status: 'skipped',
      reason: { kind: 'closed' },
    })
    expect(calls.reviews).toBe(0)
  })
})
