import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import { reviewState, reviewThread } from '../../test/support/review-state.js'
import { formatReviewJson } from '../cli/format-json.js'
import type { Publication } from '../cli/format-json.js'
import { renderReview } from '../cli/review-wiring.js'
import type { PullRequestReviewState } from '../github/pull-request-reviews.js'
import { FINDING_MARKER, resolvedMarker, reviewMarker } from '../publish/markers.js'
import type { RunRecord } from '../store/history-store.js'
import type { ReviewResult } from '../review/types.js'
import { publishSavedReview } from './publish-saved-review.js'
import type { PublishSavedReviewDeps } from './publish-saved-review.js'
import type { RenderedReview } from './review-and-publish.js'

const PR = pullRequestFixture()
const HEAD = PR.headSha
const NEWER = 'f'.repeat(40)
const FINDING = findingFixture({
  line: 3,
  confidence: 95,
  title: 'Paginação perde a última página',
})

const RESULT: ReviewResult = {
  target: { repo: PR.repo, number: PR.number, headSha: HEAD, diffFingerprint: '0123456789abcdef' },
  providerId: 'claude-cli',
  durationMs: 1000,
  passUsage: [],
  summary: 'Adiciona a rota de gasto.',
  files: [{ path: 'src/shop.ts', change: 'Adds the spend endpoint', findings: 1 }],
  findings: [FINDING],
  debt: [findingFixture({ line: 1, title: 'Old helper is unused', scope: 'repository' })],
  worthChecking: [],
  worthCheckingOmitted: 0,
  minConfidence: 75,
  score: { value: 2, reason: '1 P1 finding' },
  dropped: { invalid: 0, belowFloor: 0, outsideDiff: 0, duplicate: 0, rejected: 0 },
  claims: [],
}

const DRY_RUN: Publication = {
  status: 'dry-run',
  review: { body: 'preview', comments: [] },
  stillOpen: 0,
  wouldResolve: [
    {
      threadId: 'T-fixed',
      file: 'src/shop.ts',
      line: 9,
      title: 'Old bug',
      verdict: 'fixed',
      reason: 'The check is there now.',
      by: 'ai',
    },
  ],
}

function storedRun(changes: Partial<RunRecord> = {}, json?: string): RunRecord {
  return {
    id: 7,
    source: 'manual',
    repo: PR.repo,
    number: PR.number,
    headSha: HEAD,
    startedAt: '2026-10-29T10:00:00.000Z',
    finishedAt: '2026-10-29T10:01:00.000Z',
    status: 'dry-run',
    aiCalled: true,
    provider: 'claude',
    verdict: 'comments',
    findings: 1,
    score: 2,
    resultJson:
      json ??
      formatReviewJson(
        PR,
        { status: 'reviewed', result: RESULT },
        DRY_RUN,
        null,
        null,
        null,
        null,
        null,
        undefined,
        { language: 'pt-BR' },
      ),
    ...changes,
  }
}

interface Posted {
  owner: string
  repo: string
  number: number
  commitSha: string
  rendered: RenderedReview
}

function fakes(
  options: {
    run?: RunRecord
    head?: string
    state?: PullRequestReviewState
  } = {},
) {
  const posted: Posted[] = []
  const resolved: { threadId: string; body: string }[] = []
  const deps: PublishSavedReviewDeps = {
    readRun: (id) => (id === 7 ? (options.run ?? storedRun()) : undefined),
    fetchHead: async () => ({ headSha: options.head ?? HEAD }),
    fetchReviewState: async () => options.state ?? reviewState({ viewer: 'octocat' }),
    render: renderReview,
    createReview: async (ref, commitSha, rendered) => {
      posted.push({ ...ref, commitSha, rendered })
      return { url: 'https://github.com/acme/shop/pull/12#pullrequestreview-1' }
    },
    replyAndResolve: async (threadId, body) => {
      resolved.push({ threadId, body })
    },
    events: { warning: () => undefined },
  }
  return { deps, posted, resolved }
}

function phadaThread(id: string, title: string, line: number, resolved = false) {
  return reviewThread({
    id,
    author: 'octocat',
    path: 'src/shop.ts',
    line,
    isResolved: resolved,
    body: `**P1** · ${title} · confidence 90\n\nWhy.\n\n${FINDING_MARKER}`,
  })
}

describe('publishSavedReview', () => {
  it('posts the saved findings on the head it reviewed, in the language of the run', async () => {
    const { deps, posted } = fakes()

    const published = await publishSavedReview({ id: 7, force: false }, deps)

    expect(published).toMatchObject({
      status: 'published',
      url: 'https://github.com/acme/shop/pull/12#pullrequestreview-1',
    })
    expect(posted).toHaveLength(1)
    const [post] = posted
    expect(post).toMatchObject({ owner: 'acme', repo: 'shop', number: 12, commitSha: HEAD })
    expect(post?.rendered.body).toContain('Adiciona a rota de gasto.')
    expect(post?.rendered.body).toContain(
      reviewMarker({ sha: HEAD, findings: 1, diff: '0123456789abcdef' }),
    )
    expect(post?.rendered.body).toContain('Old helper is unused')
    expect(post?.rendered.comments).toEqual([
      expect.objectContaining({ path: 'src/shop.ts', line: 3 }),
    ])
    expect(post?.rendered.comments[0]?.body).toContain('Paginação perde a última página')
    expect(post?.rendered.comments[0]?.body).toContain('confiança 95')
  })

  it('refuses when the pull request moved since the run, posting nothing', async () => {
    const { deps, posted } = fakes({ head: NEWER })

    const published = await publishSavedReview({ id: 7, force: false }, deps)

    expect(published).toEqual({
      status: 'refused',
      refusal: { kind: 'head-moved', from: HEAD, to: NEWER },
    })
    expect(posted).toEqual([])
  })

  it('with force, posts on the commit the run reviewed even when the pull request moved', async () => {
    const { deps, posted } = fakes({ head: NEWER })

    const published = await publishSavedReview({ id: 7, force: true }, deps)

    expect(published).toMatchObject({ status: 'published', headMoved: NEWER })
    expect(posted.map(({ commitSha }) => commitSha)).toEqual([HEAD])
  })

  it('does not post a finding again while its thread is still open', async () => {
    const state = reviewState({
      viewer: 'octocat',
      threads: [phadaThread('T-open', 'Paginação perde a última página', 3)],
    })
    const { deps, posted } = fakes({ state })

    const published = await publishSavedReview({ id: 7, force: false }, deps)

    expect(published).toMatchObject({ status: 'published' })
    if (published.status !== 'published') return
    expect(published.plan.comments).toEqual([])
    expect(published.plan.stillOpen).toHaveLength(1)
    expect(posted[0]?.rendered.comments).toEqual([])
  })

  it('skips a commit Phada already reviewed, unless forced', async () => {
    const state = reviewState({
      viewer: 'octocat',
      reviews: [
        {
          id: 'R1',
          author: 'octocat',
          body: `Review\n\n${reviewMarker({ sha: HEAD, findings: 0 })}`,
          commitSha: HEAD,
        },
      ],
    })

    const skipped = fakes({ state })
    expect(await publishSavedReview({ id: 7, force: false }, skipped.deps)).toMatchObject({
      status: 'skipped',
      reason: { kind: 'already-reviewed' },
    })
    expect(skipped.posted).toEqual([])

    const forced = fakes({ state })
    expect(await publishSavedReview({ id: 7, force: true }, forced.deps)).toMatchObject({
      status: 'published',
    })
    expect(forced.posted).toHaveLength(1)
  })

  it('resolves the comments the run found fixed while they are still open', async () => {
    const open = fakes({
      state: reviewState({ viewer: 'octocat', threads: [phadaThread('T-fixed', 'Old bug', 9)] }),
    })
    const published = await publishSavedReview({ id: 7, force: false }, open.deps)
    expect(published).toMatchObject({
      status: 'published',
      resolved: { resolved: 1, failed: 0, total: 1 },
    })
    expect(open.resolved).toEqual([
      { threadId: 'T-fixed', body: expect.stringContaining(resolvedMarker(HEAD)) },
    ])

    const closed = fakes({
      state: reviewState({
        viewer: 'octocat',
        threads: [phadaThread('T-fixed', 'Old bug', 9, true)],
      }),
    })
    await publishSavedReview({ id: 7, force: false }, closed.deps)
    expect(closed.resolved).toEqual([])
  })

  it('refuses a run that is missing, was not a dry run, or found nothing to post', async () => {
    const refusal = async (run: RunRecord | undefined, id = 7) => {
      const { deps, posted } = fakes(run === undefined ? {} : { run })
      const published = await publishSavedReview({ id, force: true }, deps)
      expect(posted).toEqual([])
      return published.status === 'refused' ? published.refusal : published
    }

    expect(await refusal(undefined, 9)).toEqual({ kind: 'not-found' })
    expect(
      await refusal(storedRun({ status: 'published', url: 'https://github.com/x#r' })),
    ).toEqual({ kind: 'not-a-dry-run', status: 'published', url: 'https://github.com/x#r' })
    expect(await refusal(storedRun({ status: 'failed' }))).toEqual({
      kind: 'not-a-dry-run',
      status: 'failed',
    })
    expect(
      await refusal(
        storedRun({}, formatReviewJson(PR, { status: 'skipped', reason: 'all-ignored' }, DRY_RUN)),
      ),
    ).toEqual({ kind: 'nothing-to-publish' })
  })

  it('refuses a run saved without what publishing needs rather than post something else', async () => {
    const json = JSON.parse(storedRun().resultJson ?? '{}') as { review: Record<string, unknown> }
    delete json.review.language
    const { deps, posted } = fakes({ run: storedRun({}, JSON.stringify(json)) })

    expect(await publishSavedReview({ id: 7, force: false }, deps)).toEqual({
      status: 'refused',
      refusal: { kind: 'outdated' },
    })
    expect(posted).toEqual([])
  })
})
