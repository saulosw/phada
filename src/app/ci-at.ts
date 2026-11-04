import type { CheckRun } from '../github/check-runs.js'
import type { CommitStatus } from '../github/commit-statuses.js'
import type { CiReaders } from './read-ci.js'

export function ciReadersAt(readers: CiReaders, at: string): CiReaders {
  const moment = Date.parse(at)
  const doneBy = (instant: string | null | undefined): boolean =>
    instant !== null && instant !== undefined && Date.parse(instant) <= moment
  return {
    ...readers,
    checkRuns: async (sha) =>
      (await readers.checkRuns(sha)).map((run): CheckRun =>
        doneBy(run.completedAt)
          ? run
          : { ...run, status: 'in_progress', conclusion: null, completedAt: null },
      ),
    statuses: async (sha) =>
      (await readers.statuses(sha)).map((status): CommitStatus =>
        doneBy(status.updatedAt) ? status : { ...status, state: 'pending' },
      ),
  }
}
