import type { JobRecord, PullRecord, RequestRecord } from './types.js'
import { later } from './time.js'

export const CI_FAILING = 'ci-failing'
export const CI_REVISIT_MS = 86_400_000
export const CI_REVISITS_PER_CYCLE = 10

export interface CiRevisitInput {
  jobs: readonly JobRecord[]
  pulls: readonly PullRecord[]
  requests: readonly RequestRecord[]
  now: string
}

export function ciRevisits({ jobs, pulls, requests, now }: CiRevisitInput): JobRecord[] {
  const heads = new Map(pulls.filter(({ state }) => state === 'open').map((p) => [p.number, p]))
  const requested = new Set(
    requests.filter(({ source }) => source !== 'watch').map(({ jobId }) => jobId),
  )
  return jobs
    .filter((job) => {
      const pull = heads.get(job.number)
      return (
        revisitsCi(job, now) &&
        pull?.headSha === job.headSha &&
        (pull.eligible || requested.has(job.id))
      )
    })
    .sort((first, second) => compareText(lastRead(first), lastRead(second)) || first.id - second.id)
    .slice(0, CI_REVISITS_PER_CYCLE)
}

export function revisitsCi(job: JobRecord, now: string): boolean {
  return (
    skippedForCi(job) && job.finishedAt !== undefined && later(job.finishedAt, CI_REVISIT_MS) > now
  )
}

export function skippedForCi(job: Pick<JobRecord, 'status' | 'reason'>): boolean {
  return job.status === 'skipped' && job.reason === CI_FAILING
}

export function requeueForCi(now: string): Partial<Omit<JobRecord, 'id'>> {
  return {
    status: 'queued',
    reason: undefined,
    notBefore: now,
    finishedAt: undefined,
    ciFailing: undefined,
    ciCheckedAt: undefined,
    ciSince: now,
  }
}

function lastRead(job: JobRecord): string {
  return job.ciCheckedAt ?? job.finishedAt ?? job.createdAt
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
