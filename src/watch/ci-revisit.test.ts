import { describe, expect, it } from 'vitest'
import type { JobRecord, PullRecord, RequestRecord } from './types.js'
import { ciRevisits } from './ci-revisit.js'

const NOW = '2026-10-18T12:00:00.000Z'
const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString()
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

const pull = (number: number, overrides: Partial<PullRecord> = {}): PullRecord => ({
  repo: 'acme/shop',
  number,
  headSha: A,
  headSeenAt: at(-60),
  eligible: true,
  state: 'open',
  ...overrides,
})
const skipped = (id: number, number: number, overrides: Partial<JobRecord> = {}): JobRecord => ({
  id,
  repo: 'acme/shop',
  number,
  headSha: A,
  status: 'skipped',
  reason: 'ci-failing',
  attempts: 0,
  notBefore: at(-30),
  createdAt: at(-30),
  finishedAt: at(-30),
  ...overrides,
})
const request = (jobId: number, source: RequestRecord['source']): RequestRecord => ({
  id: jobId * 10,
  jobId,
  source,
  publish: 'none',
  createdAt: at(-30),
})

describe('ciRevisits', () => {
  it('reads again a commit skipped for CI whose pull request is open on the same commit', () => {
    const jobs = [skipped(1, 1), skipped(2, 2), skipped(3, 3), skipped(4, 4)]
    const pulls = [pull(1), pull(2, { headSha: B }), pull(3, { state: 'gone' })]

    expect(ciRevisits({ jobs, pulls, requests: [], now: NOW }).map(({ id }) => id)).toEqual([1])
  })

  it('reads again a requested commit of a pull request the watch filters out', () => {
    const jobs = [skipped(1, 1), skipped(2, 2)]
    const pulls = [pull(1, { eligible: false }), pull(2, { eligible: false })]
    const requests = [request(1, 'watch'), request(1, 'slack'), request(2, 'watch')]

    expect(ciRevisits({ jobs, pulls, requests, now: NOW }).map(({ id }) => id)).toEqual([1])
  })

  it('stops a day after the skip', () => {
    const jobs = [skipped(1, 1, { finishedAt: at(-24 * 60) })]

    expect(ciRevisits({ jobs, pulls: [pull(1)], requests: [], now: NOW })).toEqual([])
  })
})
