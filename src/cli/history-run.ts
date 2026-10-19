import { errorMessage } from '../app/error-message.js'
import type { PublicationResult, ReviewRun } from '../app/review-and-publish.js'
import type { RunOutcome } from '../app/watch-repositories.js'
import { ProviderError } from '../providers/types.js'
import { InvalidReviewReportError } from '../review/errors.js'
import type { FailureKind, JobRecord, RunRecord, RunStatus } from '../store/history-store.js'
import { errorSummary } from './format-error.js'

export interface RunMeta {
  source: 'watch' | 'manual'
  jobId?: number
  startedAt: string
  finishedAt: string
  provider: string
  model?: string
  errorKind?: FailureKind
}

export function historyRun(run: ReviewRun, json: string, meta: RunMeta): RunRecord {
  const { pullRequest } = run
  const base = {
    ...(meta.jobId === undefined ? {} : { jobId: meta.jobId }),
    source: meta.source,
    repo: pullRequest.repo,
    number: pullRequest.number,
    headSha: pullRequest.headSha,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    provider: meta.provider,
    ...(meta.model === undefined ? {} : { model: meta.model }),
    resultJson: json,
  }
  if (run.status === 'skipped') {
    return { ...base, status: 'skipped', aiCalled: false, reason: run.reason.kind }
  }
  const outcome = run.reviewed.outcome
  const result = outcome.status === 'reviewed' ? outcome.result : undefined
  return {
    ...base,
    ...publicationFields(run.publication, run.status === 'nothing' ? 'nothing' : 'published'),
    aiCalled: result !== undefined,
    ...(result === undefined
      ? {}
      : {
          findings: result.findings.length,
          score: result.score.value,
          ...(result.model === undefined ? {} : { model: result.model }),
        }),
    ...(meta.errorKind === undefined ? {} : { errorKind: meta.errorKind }),
  }
}

function publicationFields(
  publication: PublicationResult | undefined,
  none: RunStatus,
): Pick<RunRecord, 'status' | 'url' | 'reason' | 'error'> {
  if (publication === undefined) return { status: none === 'nothing' ? 'nothing' : 'skipped' }
  switch (publication.status) {
    case 'published':
      return { status: 'published', url: publication.url }
    case 'failed':
      return { status: 'failed', error: errorSummary(publication.error) }
    case 'closed-or-draft':
      return { status: 'skipped', reason: 'closed-or-draft' }
    default:
      return { status: publication.status }
  }
}

export function watchRun(
  job: JobRecord,
  outcome: RunOutcome,
  meta: RunMeta,
  runJson: (run: ReviewRun) => string,
): RunRecord {
  if ('run' in outcome) return historyRun(outcome.run, runJson(outcome.run), meta)
  return {
    jobId: job.id,
    source: meta.source,
    repo: job.repo,
    number: job.number,
    headSha: job.headSha,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    status: 'failed',
    aiCalled:
      outcome.error instanceof ProviderError || outcome.error instanceof InvalidReviewReportError,
    provider: meta.provider,
    ...(meta.model === undefined ? {} : { model: meta.model }),
    errorKind: outcome.kind,
    error: errorMessage(outcome.error),
  }
}
