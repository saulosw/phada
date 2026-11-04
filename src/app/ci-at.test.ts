import { describe, expect, it } from 'vitest'
import type { CheckRun } from '../github/check-runs.js'
import type { CommitStatus } from '../github/commit-statuses.js'
import { ciReadersAt } from './ci-at.js'
import type { CiReaders } from './read-ci.js'

const AT = '2026-10-08T10:15:00Z'

function run(id: number, completedAt: string | null, conclusion = 'failure'): CheckRun {
  return {
    id,
    name: `check ${id}`,
    status: 'completed',
    conclusion,
    title: 'Done',
    summary: null,
    url: null,
    app: 'github-actions',
    startedAt: '2026-10-08T10:00:00Z',
    completedAt,
  }
}

function status(context: string, state: string, updatedAt?: string): CommitStatus {
  return {
    context,
    state,
    description: null,
    url: null,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

function readers(runs: CheckRun[], statuses: CommitStatus[]): CiReaders {
  return {
    checkRuns: async () => runs,
    statuses: async () => statuses,
    annotations: async () => [],
    jobLog: async () => ({ text: '', partial: false }),
    permissionDenied: () => false,
    logUnavailable: () => false,
  }
}

describe('ciReadersAt', () => {
  it('shows the check runs that finished after the moment as still running', async () => {
    const cut = ciReadersAt(
      readers([run(1, '2026-10-08T10:10:00Z'), run(2, '2026-10-08T10:30:00Z'), run(3, null)], []),
      AT,
    )

    expect(await cut.checkRuns('sha')).toEqual([
      run(1, '2026-10-08T10:10:00Z'),
      { ...run(2, null), status: 'in_progress', conclusion: null },
      { ...run(3, null), status: 'in_progress', conclusion: null },
    ])
  })

  it('shows the statuses set after the moment, or without a date, as pending', async () => {
    const cut = ciReadersAt(
      readers(
        [],
        [
          status('ci/build', 'success', '2026-10-08T10:00:00Z'),
          status('ci/lint', 'failure', '2026-10-08T11:00:00Z'),
          status('ci/old', 'error'),
        ],
      ),
      AT,
    )

    expect(await cut.statuses('sha')).toEqual([
      status('ci/build', 'success', '2026-10-08T10:00:00Z'),
      status('ci/lint', 'pending', '2026-10-08T11:00:00Z'),
      status('ci/old', 'pending'),
    ])
  })
})
