import { errorMessage } from '../app/error-message.js'
import type { PublicationResult, ReviewRun } from '../app/review-and-publish.js'
import type { PullCi, RunOutcome } from '../app/watch-repositories.js'
import { ProviderError } from '../providers/types.js'
import { phadaReviewUrlAt } from '../publish/phada-state.js'
import { InvalidReviewReportError } from '../review/errors.js'
import { reviewVerdict } from '../review/verdict.js'
import type { RunRecord, RunStatus } from '../store/history-store.js'
import { CI_FAILING } from '../watch/ci-revisit.js'
import type { FailureKind, JobRecord, RequestRecord, RequestSource } from '../watch/types.js'
import { errorSummary } from './format-error.js'

export interface RunMeta {
  source: 'watch' | 'manual'
  jobId?: number
  startedAt: string
  finishedAt: string
  provider: string
  model?: string
  errorKind?: FailureKind
  requestSource?: RequestSource
}

export function historyRun(run: ReviewRun, json: string, meta: RunMeta): RunRecord {
  const { pullRequest } = run
  const base = {
    ...(meta.jobId === undefined ? {} : { jobId: meta.jobId }),
    source: meta.source,
    ...(meta.requestSource === undefined ? {} : { requestSource: meta.requestSource }),
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
    const url =
      run.reason.kind === 'already-reviewed' && run.reviewState !== undefined
        ? phadaReviewUrlAt(run.reviewState, pullRequest.headSha)
        : undefined
    return {
      ...base,
      status: 'skipped',
      aiCalled: false,
      reason: run.reason.kind,
      verdict: 'skipped',
      ...(url === undefined ? {} : { url }),
    }
  }
  const outcome = run.reviewed.outcome
  const result = outcome.status === 'reviewed' ? outcome.result : undefined
  return {
    ...base,
    ...publicationFields(run.publication, run.status === 'nothing' ? 'nothing' : 'published'),
    aiCalled: result !== undefined,
    verdict: result === undefined ? 'skipped' : reviewVerdict(result),
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
  if ('ci' in outcome) return ciFailingRun(job, outcome.ci, meta)
  return {
    jobId: job.id,
    source: meta.source,
    ...(meta.requestSource === undefined ? {} : { requestSource: meta.requestSource }),
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
    verdict: 'failed',
  }
}

function ciFailingRun(job: JobRecord, ci: PullCi, meta: RunMeta): RunRecord {
  const { state, failing, pending } = ci.summary
  return {
    jobId: job.id,
    source: meta.source,
    ...(meta.requestSource === undefined ? {} : { requestSource: meta.requestSource }),
    repo: job.repo,
    number: job.number,
    headSha: job.headSha,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    status: 'skipped',
    aiCalled: false,
    reason: job.reason ?? CI_FAILING,
    verdict: 'skipped',
    resultJson: JSON.stringify({ ci: { state, failing, pending, checks: ci.checks } }),
  }
}

export function requestSourceOf(requests: readonly RequestRecord[]): RequestSource | undefined {
  return (requests.find(({ source }) => source !== 'watch') ?? requests[0])?.source
}
