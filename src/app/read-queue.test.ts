import { describe, expect, it } from 'vitest'
import type { WatchSettings } from '../config/watch-settings.js'
import type { HistoryStatus, RunRecord } from '../store/history-store.js'
import type { JobRecord, RequestRecord } from '../watch/types.js'
import { readQueue } from './read-queue.js'
import type { QueueHistory } from './read-queue.js'

const NOW = new Date('2026-10-25T12:00:00.000Z')
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const SETTINGS: WatchSettings = {
  intervalMs: 300_000,
  settleMs: 180_000,
  maxReviewsPerHour: 6,
  repos: [{ repo: 'acme/shop', publish: 'pr', allowExternal: false }],
}

function job(id: number, changes: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    repo: 'acme/shop',
    number: id,
    headSha: SHA,
    status: 'queued',
    attempts: 0,
    notBefore: '2026-10-25T11:58:00.000Z',
    createdAt: '2026-10-25T11:55:00.000Z',
    ...changes,
  }
}

function request(id: number, jobId: number, source: RequestRecord['source']): RequestRecord {
  return { id, jobId, source, publish: 'pr', createdAt: '2026-10-25T11:55:00.000Z' }
}

function fakeHistory(
  options: {
    status?: Partial<HistoryStatus>
    jobs?: JobRecord[]
    requests?: RequestRecord[]
    runTimes?: string[]
  } = {},
): QueueHistory {
  const jobs = options.jobs ?? []
  return {
    status: () => ({
      repos: [],
      queued: [],
      running: [],
      failed: [],
      lastRuns: [],
      ...options.status,
    }),
    jobs: ({ status }) => jobs.filter((record) => status?.includes(record.status) ?? true),
    requests: (ids) => (options.requests ?? []).filter(({ jobId }) => ids.includes(jobId)),
    watchRunsSince: (since) => (options.runTimes ?? []).filter((time) => time > since),
  }
}

describe('readQueue', () => {
  it('reads an empty queue when there is no history file', () => {
    expect(
      readQueue({ history: undefined, settings: SETTINGS, holder: undefined, now: NOW }),
    ).toEqual({
      recorded: false,
      holder: null,
      pause: null,
      hourly: { count: 0, max: 6 },
      repos: [],
      lastCycleAt: null,
      nextCycle: null,
      queue: [],
      running: [],
      skippedForCi: [],
      failed: [],
      lastRuns: [],
    })
  })

  it('estimates the next cycle from the last one while a watch holds the lock', () => {
    const history = fakeHistory({
      status: {
        repos: [
          { repo: 'acme/api', checkedAt: '2026-10-25T11:50:00.000Z' },
          { repo: 'acme/shop', checkedAt: '2026-10-25T11:57:00.000Z' },
          { repo: 'acme/web' },
        ],
      },
    })

    const view = readQueue({ history, settings: SETTINGS, holder: 4242, now: NOW })

    expect(view.holder).toEqual({ pid: 4242 })
    expect(view.lastCycleAt).toBe('2026-10-25T11:57:00.000Z')
    expect(view.nextCycle).toEqual({ at: '2026-10-25T12:02:00.000Z', estimated: true })
  })

  it('gives no next cycle when no watch holds the lock', () => {
    const history = fakeHistory({
      status: { repos: [{ repo: 'acme/shop', checkedAt: '2026-10-25T11:57:00.000Z' }] },
    })

    const view = readQueue({ history, settings: SETTINGS, holder: undefined, now: NOW })

    expect(view.holder).toBeNull()
    expect(view.lastCycleAt).toBe('2026-10-25T11:57:00.000Z')
    expect(view.nextCycle).toBeNull()
  })

  it('keeps a pause only while it lasts', () => {
    const until = '2026-10-25T12:30:00.000Z'
    const active = fakeHistory({ status: { pause: { until, reason: 'rate-limit', streak: 1 } } })
    const over = fakeHistory({
      status: { pause: { until: '2026-10-25T11:00:00.000Z', reason: 'rate-limit', streak: 1 } },
    })

    expect(readQueue({ history: active, settings: SETTINGS, holder: 1, now: NOW }).pause).toEqual({
      until,
      reason: 'rate-limit',
      streak: 1,
    })
    expect(readQueue({ history: over, settings: SETTINGS, holder: 1, now: NOW }).pause).toBeNull()
  })

  it('counts the reviews of the last hour against the limit, and none without watch settings', () => {
    const history = fakeHistory({
      runTimes: [
        '2026-10-25T10:30:00.000Z',
        '2026-10-25T11:10:00.000Z',
        '2026-10-25T11:50:00.000Z',
      ],
    })

    expect(readQueue({ history, settings: SETTINGS, holder: 1, now: NOW }).hourly).toEqual({
      count: 2,
      max: 6,
    })
    expect(readQueue({ history, settings: undefined, holder: 1, now: NOW }).hourly).toBeNull()
  })

  it('gives each job of the queue its requests, with the jobs waiting for CI in their order', () => {
    const waiting = job(2, {
      status: 'waiting',
      reason: 'ci-pending',
      ciDeadline: '2026-10-25T12:10:00.000Z',
      ciPending: ['test'],
    })
    const queued = { ...job(3), sources: ['slack' as const] }
    const running = job(4, { status: 'running', startedAt: '2026-10-25T11:59:00.000Z' })
    const history = fakeHistory({
      status: { queued: [waiting, queued], running: [running] },
      requests: [request(1, 2, 'watch'), request(2, 3, 'slack'), request(3, 4, 'enqueue')],
    })

    const view = readQueue({ history, settings: SETTINGS, holder: 1, now: NOW })

    expect(view.queue).toEqual([
      { job: waiting, requests: [request(1, 2, 'watch')] },
      { job: queued, requests: [request(2, 3, 'slack')] },
    ])
    expect(view.running).toEqual([{ job: running, requests: [request(3, 4, 'enqueue')] }])
  })

  it('lists the jobs skipped for failing CI that are still read again, with the failing checks', () => {
    const recent = job(5, {
      status: 'skipped',
      reason: 'ci-failing',
      ciFailing: ['test'],
      finishedAt: '2026-10-25T09:00:00.000Z',
    })
    const expired = job(6, {
      status: 'skipped',
      reason: 'ci-failing',
      ciFailing: ['lint'],
      finishedAt: '2026-10-23T09:00:00.000Z',
    })
    const sameDiff = job(7, {
      status: 'skipped',
      reason: 'same-diff',
      finishedAt: '2026-10-25T09:00:00.000Z',
    })
    const history = fakeHistory({
      jobs: [recent, expired, sameDiff],
      requests: [request(4, 5, 'pr-command')],
    })

    const view = readQueue({ history, settings: SETTINGS, holder: 1, now: NOW })

    expect(view.skippedForCi).toEqual([{ job: recent, requests: [request(4, 5, 'pr-command')] }])
  })

  it('keeps the recent failures with their reason and the last run of each repository', () => {
    const failed = job(8, {
      status: 'failed',
      errorKind: 'definitive',
      error: 'pull request not found',
      finishedAt: '2026-10-25T11:00:00.000Z',
    })
    const lastRun: RunRecord = {
      source: 'watch',
      repo: 'acme/shop',
      number: 1,
      headSha: SHA,
      startedAt: '2026-10-25T10:00:00.000Z',
      finishedAt: '2026-10-25T10:01:00.000Z',
      status: 'published',
      aiCalled: true,
    }
    const history = fakeHistory({ status: { failed: [failed], lastRuns: [lastRun] } })

    const view = readQueue({ history, settings: SETTINGS, holder: undefined, now: NOW })

    expect(view.recorded).toBe(true)
    expect(view.failed).toEqual([{ job: failed, requests: [] }])
    expect(view.lastRuns).toEqual([lastRun])
  })
})
