import { describe, expect, it } from 'vitest'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import type { PullRequestTimeline } from '../github/pull-request-timeline.js'
import type { PullRequestMetadata } from '../github/pull-request.js'
import { HeadNotInPullRequestError, loadReplay, replayWarning } from './replay.js'
import type { ReplayReaders } from './replay.js'

const REF = { owner: 'acme', repo: 'shop', number: 12 }
const FIRST = '1e6a005c3b7d4e2f8a9b0c1d2e3f4a5b6c7d8e9f'
const SECOND = '2f7b116d4c8e5f3a9b0c1d2e3f4a5b6c7d8e9f01'
const PUSHED = 'e0fe8171a2b3c4d5e6f708192a3b4c5d6e7f8091'
const GONE = '9a8b7c6d5e4f30211203f4e5d6c7b8a9f0e1d2c3'
const AWHILE = '7c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d'
const OLD_DIFF = [
  'diff --git a/src/shop.ts b/src/shop.ts',
  '--- a/src/shop.ts',
  '+++ b/src/shop.ts',
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+c',
  '+++ not a header',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1 @@',
  '+export {}',
  '',
].join('\n')

const TIMELINE: PullRequestTimeline = {
  commits: [
    { oid: FIRST, committedDate: '2026-10-07T20:41:12Z' },
    { oid: SECOND, committedDate: '2026-10-07T22:00:00Z' },
    { oid: PUSHED, committedDate: '2026-10-08T10:12:40Z' },
  ],
  forcePushes: [
    {
      createdAt: '2026-10-08T10:15:00Z',
      before: { oid: GONE, committedDate: '2026-10-08T08:00:00Z' },
      after: { oid: PUSHED, committedDate: '2026-10-08T10:12:40Z' },
    },
    {
      createdAt: '2026-10-08T12:00:00Z',
      before: { oid: AWHILE, committedDate: '2026-10-08T10:50:00Z' },
      after: { oid: PUSHED, committedDate: '2026-10-08T10:12:40Z' },
    },
    {
      createdAt: '2026-10-08T11:00:00Z',
      before: { oid: PUSHED, committedDate: '2026-10-08T10:12:40Z' },
      after: { oid: AWHILE, committedDate: '2026-10-08T10:50:00Z' },
    },
    { createdAt: '2026-10-09T08:00:00Z', before: null, after: null },
  ],
}

function readers(timeline: PullRequestTimeline = TIMELINE) {
  const diffs: { base: string; head: string }[] = []
  const { diff: _diff, ...metadata } = pullRequestFixture()
  const deps: ReplayReaders = {
    fetchPullRequestMetadata: async () => metadata satisfies PullRequestMetadata,
    fetchTimeline: async () => timeline,
    fetchDiffAt: async (_ref, base, head) => {
      diffs.push({ base, head })
      return OLD_DIFF
    },
  }
  return { deps, diffs }
}

describe('loadReplay', () => {
  it('builds the pull request at a commit: its SHA, the diff up to it and its stats', async () => {
    const { deps, diffs } = readers()

    const replay = await loadReplay(REF, '1e6a005', deps)

    expect(replay.pullRequest).toMatchObject({
      title: 'Let users spend crystals',
      headSha: FIRST,
      diff: OLD_DIFF,
      stats: { changedFiles: 2, additions: 3, deletions: 1, commits: 1 },
    })
    expect(diffs).toEqual([{ base: '0'.repeat(40), head: FIRST }])
  })

  it('cuts at the commit date, flagged approximate, when no force-push brought the commit', async () => {
    const replay = await loadReplay(REF, SECOND, readers().deps)

    expect(replay).toMatchObject({ at: '2026-10-07T22:00:00Z', approximate: true })
    expect(replay.pullRequest.stats.commits).toBe(2)
    expect(replayWarning(replay)).toBe(
      'The cut is approximate: GitHub does not record when a normal push happened, so the conversation is cut at the commit date of 2f7b116 (2026-10-07T22:00:00Z).',
    )
  })

  it('cuts at the first force-push that brought the commit, exactly, even when a later one brought it back', async () => {
    const replay = await loadReplay(REF, PUSHED, readers().deps)

    expect(replay).toMatchObject({ at: '2026-10-08T10:15:00Z', approximate: false })
    expect(replayWarning(replay)).toBeUndefined()
  })

  it('replays a commit a force-push replaced, at its commit date', async () => {
    const replay = await loadReplay(REF, GONE, readers().deps)

    expect(replay).toMatchObject({ at: '2026-10-08T08:00:00Z', approximate: true })
    expect(replay.pullRequest).toMatchObject({ headSha: GONE, stats: { commits: 1 } })
  })

  it('refuses a commit that is not in the pull request', async () => {
    await expect(loadReplay(REF, 'abcdef0', readers().deps)).rejects.toThrow(
      new HeadNotInPullRequestError('abcdef0 is not a commit of acme/shop#12.'),
    )
  })

  it('refuses a prefix that matches several commits', async () => {
    const twins: PullRequestTimeline = {
      commits: [
        { oid: `1e6a005a${'0'.repeat(32)}`, committedDate: '2026-10-07T20:41:12Z' },
        { oid: `1e6a005b${'0'.repeat(32)}`, committedDate: '2026-10-07T20:42:12Z' },
      ],
      forcePushes: [],
    }

    await expect(loadReplay(REF, '1e6a005', readers(twins).deps)).rejects.toThrow(
      new HeadNotInPullRequestError(
        '1e6a005 matches several commits of acme/shop#12: give more of the SHA.',
      ),
    )
  })
})
