import { describe, expect, it } from 'vitest'
import type { RunRecord } from '../store/history-store.js'
import type { JobRecord, RequestRecord } from '../watch/types.js'
import { reviewEvent } from './review-event.js'

const SHA = 'a'.repeat(40)
const JOB: JobRecord = {
  id: 4,
  repo: 'acme/shop',
  number: 12,
  headSha: SHA,
  status: 'done',
  attempts: 0,
  notBefore: '2026-10-23T12:00:00.000Z',
  publish: 'none',
  createdAt: '2026-10-23T12:00:00.000Z',
}
const SLACK: RequestRecord = {
  id: 1,
  jobId: 4,
  source: 'slack',
  publish: 'none',
  data: { channel: 'C1', ts: '1.2' },
  createdAt: '2026-10-23T12:00:00.000Z',
}
const RUN: RunRecord = {
  id: 9,
  jobId: 4,
  source: 'watch',
  repo: 'acme/shop',
  number: 12,
  headSha: SHA,
  startedAt: '2026-10-23T12:01:00.000Z',
  finishedAt: '2026-10-23T12:04:00.000Z',
  status: 'not-published',
  aiCalled: true,
  verdict: 'blocking',
  resultJson: '{"schemaVersion":1,"status":"reviewed","verdict":"blocking"}',
}
const JOB_JSON = {
  id: 4,
  repo: 'acme/shop',
  number: 12,
  headSha: SHA,
  url: 'https://github.com/acme/shop/pull/12',
}

describe('reviewEvent', () => {
  it('carries the full review, the verdict and the publication when a review finishes', () => {
    expect(reviewEvent({ kind: 'finished', job: JOB, requests: [SLACK] }, RUN)).toEqual({
      schemaVersion: 1,
      event: 'review.finished',
      job: JOB_JSON,
      requests: [{ source: 'slack', publish: 'none', data: { channel: 'C1', ts: '1.2' } }],
      verdict: 'blocking',
      publication: { status: 'not-published' },
      review: { schemaVersion: 1, status: 'reviewed', verdict: 'blocking' },
    })
  })

  it('has the link of the published review', () => {
    const published = { ...RUN, status: 'published' as const, url: 'https://x/r1' }
    expect(
      reviewEvent({ kind: 'finished', job: JOB, requests: [] }, published).publication,
    ).toEqual({ status: 'published', url: 'https://x/r1' })
  })

  it('has no verdict nor review when a review starts', () => {
    expect(
      reviewEvent({ kind: 'started', job: { ...JOB, status: 'running' }, requests: [] }, undefined),
    ).toEqual({
      schemaVersion: 1,
      event: 'review.started',
      job: JOB_JSON,
      requests: [],
      verdict: null,
      publication: null,
    })
  })

  it('says why a review was skipped', () => {
    expect(
      reviewEvent({ kind: 'skipped', job: JOB, requests: [], reason: 'closed' }, undefined),
    ).toMatchObject({ event: 'review.skipped', verdict: 'skipped', reason: 'closed' })
  })

  it('has the error of a failed review', () => {
    const failed = { ...JOB, status: 'failed' as const, error: 'GitHub 502' }
    expect(reviewEvent({ kind: 'failed', job: failed, requests: [] }, undefined)).toMatchObject({
      event: 'review.failed',
      verdict: 'failed',
      error: 'GitHub 502',
    })
  })
})
