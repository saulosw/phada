import { describe, expect, it } from 'vitest'
import type { JobRecord } from '../store/history-store.js'
import { afterFailure } from './failures.js'

const NOW = '2026-10-18T12:00:00.000Z'
const JOB: JobRecord = {
  id: 1,
  repo: 'acme/shop',
  number: 3,
  headSha: 'a'.repeat(40),
  status: 'running',
  attempts: 0,
  notBefore: NOW,
  createdAt: NOW,
}
const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString()

describe('afterFailure', () => {
  it('retries a transient failure after 1 minute, then 5 minutes, then fails', () => {
    expect(afterFailure({ job: JOB, kind: 'transient', now: NOW })).toEqual({
      job: { status: 'queued', attempts: 1, notBefore: at(60_000), errorKind: 'transient' },
    })
    expect(afterFailure({ job: { ...JOB, attempts: 1 }, kind: 'transient', now: NOW })).toEqual({
      job: { status: 'queued', attempts: 2, notBefore: at(300_000), errorKind: 'transient' },
    })
    expect(afterFailure({ job: { ...JOB, attempts: 2 }, kind: 'transient', now: NOW })).toEqual({
      job: { status: 'failed', attempts: 3, errorKind: 'transient', finishedAt: NOW },
    })
  })

  it('pauses the queue for a usage limit without counting an attempt', () => {
    expect(afterFailure({ job: JOB, kind: 'usage-limit', now: NOW })).toEqual({
      job: { status: 'queued', errorKind: 'usage-limit' },
      pause: { until: at(900_000), reason: 'usage-limit', streak: 1 },
    })
  })

  it('doubles the pause for each usage limit in a row, up to 2 hours', () => {
    const pause = (streak: number) => ({ until: NOW, reason: 'usage-limit', streak })

    expect(
      afterFailure({ job: JOB, kind: 'usage-limit', now: NOW, pause: pause(1) }).pause,
    ).toEqual({ until: at(1_800_000), reason: 'usage-limit', streak: 2 })
    expect(
      afterFailure({ job: JOB, kind: 'usage-limit', now: NOW, pause: pause(4) }).pause,
    ).toEqual({ until: at(7_200_000), reason: 'usage-limit', streak: 5 })
  })

  it('pauses until the GitHub rate limit resets, plus 5 seconds', () => {
    const resetAt = at(600_000)

    expect(afterFailure({ job: JOB, kind: 'rate-limit', now: NOW, resetAt })).toEqual({
      job: { status: 'queued', errorKind: 'rate-limit' },
      pause: { until: at(605_000), reason: 'rate-limit', streak: 1 },
    })
    expect(afterFailure({ job: JOB, kind: 'rate-limit', now: NOW }).pause).toEqual({
      until: at(900_000),
      reason: 'rate-limit',
      streak: 1,
    })
  })

  it('fails a definitive failure at once', () => {
    expect(afterFailure({ job: JOB, kind: 'definitive', now: NOW })).toEqual({
      job: { status: 'failed', attempts: 1, errorKind: 'definitive', finishedAt: NOW },
    })
  })

  it('puts the job back and stops the watch on a fatal failure', () => {
    expect(afterFailure({ job: { ...JOB, attempts: 1 }, kind: 'fatal', now: NOW })).toEqual({
      job: { status: 'queued', errorKind: 'fatal' },
      stop: true,
    })
  })
})
