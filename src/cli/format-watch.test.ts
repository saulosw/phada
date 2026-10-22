import { describe, expect, it } from 'vitest'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import type { ReviewRun } from '../app/review-and-publish.js'
import type { HistoryStatus } from '../store/history-store.js'
import type { JobRecord } from '../watch/types.js'
import { formatWatchEvent, formatWatchStatus, formatWatchStatusJson } from './format-watch.js'

const local = (hours: number, minutes: number) => new Date(2026, 9, 18, hours, minutes)
const AT = local(14, 3)
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const JOB: JobRecord = {
  id: 1,
  repo: 'acme/shop',
  number: 3,
  headSha: SHA,
  status: 'queued',
  attempts: 0,
  notBefore: local(14, 6).toISOString(),
  createdAt: local(14, 3).toISOString(),
}
const published: ReviewRun = {
  status: 'reviewed',
  pullRequest: pullRequestFixture({ number: 3 }),
  reviewed: {} as never,
  plan: {
    comments: [],
    stillOpen: [],
    dismissed: [],
    fixedAgain: [],
    fixedThreads: 0,
    openThreads: 0,
  },
  rendered: { body: '', comments: [] },
  publication: {
    status: 'published',
    url: 'https://github.com/acme/shop/pull/3#r1',
    resolved: { resolved: 0, failed: 0, total: 0 },
  },
}

describe('formatWatchEvent', () => {
  it.each([
    [
      { kind: 'baseline', repo: 'acme/shop', count: 2 },
      '[14:03] acme/shop: 2 open pull requests recorded as they are; new pushes will be reviewed.',
    ],
    [{ kind: 'queued', job: JOB }, '[14:03] Queued acme/shop#3 at a1b2c3d; review after 14:06.'],
    [{ kind: 'superseded', job: JOB }, '[14:03] acme/shop#3: a newer commit replaces a1b2c3d.'],
    [{ kind: 'started', job: JOB }, '[14:03] Reviewing acme/shop#3 at a1b2c3d…'],
    [
      { kind: 'finished', job: JOB, run: published },
      '[14:03] Published acme/shop#3: https://github.com/acme/shop/pull/3#r1',
    ],
    [
      {
        kind: 'finished',
        job: JOB,
        run: { ...published, publication: { status: 'not-published' } },
      },
      '[14:03] Reviewed acme/shop#3; kept in the history, not published.',
    ],
    [
      {
        kind: 'finished',
        job: JOB,
        run: { ...published, publication: { status: 'superseded', headSha: 'f'.repeat(40) } },
      },
      '[14:03] acme/shop#3 moved to fffffff during the review; not published.',
    ],
    [
      {
        kind: 'finished',
        job: JOB,
        run: {
          status: 'skipped',
          pullRequest: published.pullRequest,
          reason: { kind: 'already-reviewed' },
        },
      },
      '[14:03] acme/shop#3: a1b2c3d already reviewed by Phada: skipping.',
    ],
    [
      {
        kind: 'retry',
        job: JOB,
        at: local(14, 4).toISOString(),
        error: new Error('socket hang up'),
      },
      '[14:03] acme/shop#3 failed (socket hang up); trying again at 14:04.',
    ],
    [
      {
        kind: 'paused',
        pause: { until: local(14, 18).toISOString(), reason: 'usage-limit', streak: 1 },
      },
      "[14:03] Paused until 14:18: the AI provider's usage limit.",
    ],
    [
      {
        kind: 'paused',
        pause: { until: local(14, 18).toISOString(), reason: 'rate-limit', streak: 1 },
      },
      '[14:03] Paused until 14:18: the GitHub rate limit.',
    ],
    [
      { kind: 'failed', job: JOB, error: new Error('bad\u001b[31m') },
      '[14:03] acme/shop#3 failed: bad[31m. A new commit is reviewed again.',
    ],
    [
      { kind: 'indexed', repo: 'acme/shop', sha: SHA },
      '[14:03] acme/shop: index of the default branch updated to a1b2c3d.',
    ],
    [
      { kind: 'indexPartial', repo: 'acme/shop' },
      '[14:03] acme/shop: indexing the default branch; it goes on when the queue is idle.',
    ],
    [{ kind: 'warning', message: 'acme/web: no access' }, '[14:03] Warning: acme/web: no access'],
    [
      { kind: 'limited', count: 6, until: local(14, 40).toISOString() },
      '[14:03] 6 reviews in the last hour (maxReviewsPerHour): the next one starts at 14:40.',
    ],
  ] as const)('prints %j', (event, line) => {
    expect(formatWatchEvent(event, AT)).toBe(line)
  })
})

const STATUS: HistoryStatus = {
  repos: [
    {
      repo: 'acme/shop',
      checkedAt: local(14, 0).toISOString(),
      indexedSha: SHA,
      pullsEtag: 'W/"1"',
      branchEtag: '"2"',
    },
    { repo: 'acme/web' },
  ],
  queued: [{ ...JOB, attempts: 1 }],
  running: [{ ...JOB, number: 5, status: 'running', startedAt: local(14, 1).toISOString() }],
  failed: [
    {
      ...JOB,
      number: 6,
      status: 'failed',
      error: 'boom',
      errorKind: 'definitive',
      finishedAt: local(13, 0).toISOString(),
    },
  ],
  lastRuns: [
    {
      source: 'watch',
      repo: 'acme/shop',
      number: 3,
      headSha: SHA,
      startedAt: local(13, 50).toISOString(),
      finishedAt: local(13, 55).toISOString(),
      status: 'published',
      aiCalled: true,
      url: 'https://github.com/acme/shop/pull/3#r1',
    },
  ],
  pause: { until: local(14, 30).toISOString(), reason: 'usage-limit', streak: 1 },
}

describe('formatWatchStatus', () => {
  it('shows the watch, the pause, the repositories, the queue, failures and the last reviews', () => {
    expect(formatWatchStatus(STATUS, { pid: 123 }, AT, { count: 6, max: 6 })).toBe(
      [
        'Watch: running (PID 123)',
        "Paused until 2026-10-18 14:30: the AI provider's usage limit.",
        'Reviews in the last hour: 6 of 6',
        '',
        'Repositories:',
        '  acme/shop  checked 2026-10-18 14:00 · index at a1b2c3d',
        '  acme/web   not checked yet',
        '',
        'Queue:',
        '  acme/shop#3  a1b2c3d  after 2026-10-18 14:06 · attempt 2',
        '',
        'In progress:',
        '  acme/shop#5  a1b2c3d  since 2026-10-18 14:01',
        '',
        'Failed:',
        '  acme/shop#6  a1b2c3d  2026-10-18 13:00  boom',
        '',
        'Last reviews:',
        '  acme/shop#3  a1b2c3d  published 2026-10-18 13:55  https://github.com/acme/shop/pull/3#r1',
        '',
      ].join('\n'),
    )
  })

  it('says when nothing runs and nothing is queued', () => {
    const empty: HistoryStatus = { repos: [], queued: [], running: [], failed: [], lastRuns: [] }

    expect(formatWatchStatus(empty, undefined, AT)).toBe(
      [
        'Watch: not running',
        '',
        'Repositories: none yet',
        'Queue: empty',
        'In progress: none',
        'Failed: none',
        'Last reviews: none',
        '',
      ].join('\n'),
    )
  })

  it('leaves out a pause that is over', () => {
    const over = { ...STATUS, pause: { ...STATUS.pause!, until: local(13, 0).toISOString() } }

    expect(formatWatchStatus(over, undefined, AT)).not.toContain('Paused')
  })
})

describe('formatWatchStatusJson', () => {
  it('prints schemaVersion 1 with every block', () => {
    const json = JSON.parse(
      formatWatchStatusJson(STATUS, { pid: 123 }, AT, { count: 6, max: 6 }),
    ) as Record<string, unknown>

    expect(json).toEqual({
      schemaVersion: 1,
      running: { pid: 123 },
      pause: STATUS.pause,
      reviewsLastHour: { count: 6, max: 6 },
      repos: [
        { repo: 'acme/shop', checkedAt: STATUS.repos[0]?.checkedAt, indexedSha: SHA },
        { repo: 'acme/web' },
      ],
      queue: STATUS.queued,
      inProgress: STATUS.running,
      failed: STATUS.failed,
      lastRuns: STATUS.lastRuns,
    })
    expect(
      JSON.parse(formatWatchStatusJson({ ...STATUS, pause: undefined } as never, undefined, AT)),
    ).toMatchObject({ running: null, pause: null })
  })
})
