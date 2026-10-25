import { describe, expect, it } from 'vitest'
import type { JobRecord } from '../watch/types.js'
import { formatHistoryText } from './format-history.js'
import { watchRun } from './history-run.js'
import type { RunMeta } from './history-run.js'

const AT = '2026-10-18T12:08:00.000Z'
const JOB: JobRecord = {
  id: 4,
  repo: 'acme/shop',
  number: 3,
  headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  status: 'skipped',
  reason: 'ci-failing',
  attempts: 0,
  notBefore: AT,
  createdAt: AT,
  finishedAt: AT,
  ciFailing: ['test', 'lint'],
}
const META: RunMeta = {
  source: 'watch',
  jobId: 4,
  startedAt: AT,
  finishedAt: AT,
  provider: 'unknown',
  requestSource: 'slack',
}

describe('watchRun', () => {
  it('records a commit skipped for failing CI without a provider, with the checks that count', () => {
    const run = watchRun(
      JOB,
      {
        skippedForCi: {
          waitMs: 900_000,
          onFailure: 'skip',
          summary: { state: 'failing', pending: [], failing: ['test', 'lint'] },
          checks: [
            { name: 'build', state: 'passing' },
            { name: 'test', state: 'failing' },
            { name: 'lint', state: 'failing' },
          ],
        },
      },
      META,
      () => {
        throw new Error('no review run')
      },
    )

    expect(run).toEqual({
      jobId: 4,
      source: 'watch',
      requestSource: 'slack',
      repo: 'acme/shop',
      number: 3,
      headSha: JOB.headSha,
      startedAt: AT,
      finishedAt: AT,
      status: 'skipped',
      aiCalled: false,
      reason: 'ci-failing',
      verdict: 'skipped',
      resultJson: expect.any(String),
    })
    expect(JSON.parse(run.resultJson ?? '')).toEqual({
      ci: {
        state: 'failing',
        failing: ['test', 'lint'],
        pending: [],
        checks: [
          { name: 'build', state: 'passing' },
          { name: 'test', state: 'failing' },
          { name: 'lint', state: 'failing' },
        ],
      },
    })
    expect(formatHistoryText([run], 1, undefined)).toMatch(
      /acme\/shop#3 {2}a1b2c3d {2}slack {7}skipped {4}ci-failing\n$/,
    )
  })
})
