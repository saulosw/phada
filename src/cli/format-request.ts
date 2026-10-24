import type { SubmitResult } from '../app/submit-request.js'
import type { RefusalReason } from '../watch/request-policy.js'
import type { JobRecord } from '../watch/types.js'
import { shortSha } from './review-text.js'

const SCHEMA_VERSION = 1

export function refusalText(
  reason: RefusalReason,
  result: { job?: JobRecord; until?: string },
): string {
  switch (reason) {
    case 'not-watched':
      return 'the repository is not listed under watch: in your config'
    case 'closed':
      return 'the pull request is closed'
    case 'external':
      return 'the author is outside the repository (allowExternal: true in watch: lets them in)'
    case 'already-reviewed':
      return result.job === undefined
        ? 'this commit was already reviewed'
        : `this commit was already reviewed (job ${result.job.id})`
    case 'hourly-limit':
      return result.until === undefined
        ? 'the hourly limit of new reviews is reached'
        : `the hourly limit of new reviews is reached until ${result.until.slice(11, 16)} UTC`
  }
}

export function formatSubmitText(ref: string, result: SubmitResult): string {
  if (result.status === 'refused') return `Refused ${ref}: ${refusalText(result.reason, result)}.`
  const sha = shortSha(result.job.headSha)
  return result.status === 'queued'
    ? `Queued ${ref} at ${sha} (job ${result.job.id}).`
    : `Joined job ${result.job.id} for ${ref} at ${sha}.`
}

export function formatSubmitJson(result: SubmitResult, watchRunning: boolean): string {
  const job = result.job === undefined ? {} : { job: jobJson(result.job) }
  const value =
    result.status === 'refused'
      ? {
          schemaVersion: SCHEMA_VERSION,
          status: result.status,
          reason: result.reason,
          ...job,
          ...(result.until === undefined ? {} : { until: result.until }),
          watchRunning,
        }
      : { schemaVersion: SCHEMA_VERSION, status: result.status, ...job, watchRunning }
  return `${JSON.stringify(value, null, 2)}\n`
}

export function jobJson(job: JobRecord) {
  return {
    id: job.id,
    repo: job.repo,
    number: job.number,
    headSha: job.headSha,
    status: job.status,
    publish: job.publish ?? 'pr',
  }
}
