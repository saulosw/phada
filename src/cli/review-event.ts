import type { JobEvent } from '../app/watch-repositories.js'
import type { ReviewEventName } from '../config/schema.js'
import type { Verdict } from '../review/verdict.js'
import type { RunRecord, RunStatus } from '../store/history-store.js'
import type { JobRecord, PublishTarget, RequestRecord, RequestSource } from '../watch/types.js'

const SCHEMA_VERSION = 1

export interface ReviewEvent {
  schemaVersion: typeof SCHEMA_VERSION
  event: ReviewEventName
  job: { id: number; repo: string; number: number; headSha: string; url: string }
  requests: { source: RequestSource; publish: PublishTarget; data?: Record<string, unknown> }[]
  verdict: Verdict | null
  reason?: string
  publication: { status: RunStatus; url?: string } | null
  review?: unknown
  error?: string
}

export function reviewEvent(event: JobEvent, run: RunRecord | undefined): ReviewEvent {
  const { job, kind } = event
  const ended = kind === 'finished' || kind === 'skipped'
  const error = kind === 'failed' ? (job.error ?? run?.error) : undefined
  return {
    schemaVersion: SCHEMA_VERSION,
    event: `review.${kind}`,
    job: {
      id: job.id,
      repo: job.repo,
      number: job.number,
      headSha: job.headSha,
      url: `https://github.com/${job.repo}/pull/${job.number}`,
    },
    requests: event.requests.map(({ source, publish, data }) => ({
      source,
      publish,
      ...(data === undefined ? {} : { data }),
    })),
    verdict: verdictOf(kind, run),
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    publication:
      ended && run !== undefined
        ? { status: run.status, ...(run.url === undefined ? {} : { url: run.url }) }
        : null,
    ...(kind === 'finished' && run?.resultJson !== undefined
      ? { review: JSON.parse(run.resultJson) as unknown }
      : {}),
    ...(error === undefined ? {} : { error }),
  }
}

function verdictOf(kind: JobEvent['kind'], run: RunRecord | undefined): Verdict | null {
  switch (kind) {
    case 'started':
      return null
    case 'failed':
      return 'failed'
    case 'skipped':
      return 'skipped'
    case 'finished':
      return run?.verdict ?? null
  }
}

export function storedEvent(
  job: JobRecord,
  requests: readonly RequestRecord[],
  run: RunRecord | undefined,
): ReviewEvent | undefined {
  switch (job.status) {
    case 'queued':
    case 'running':
      return undefined
    case 'done':
      return reviewEvent({ kind: 'finished', job, requests }, run)
    case 'failed':
      return reviewEvent({ kind: 'failed', job, requests }, run)
    case 'superseded':
      return reviewEvent({ kind: 'skipped', job, requests, reason: 'superseded' }, run)
    case 'skipped':
      return reviewEvent(
        {
          kind: 'skipped',
          job,
          requests,
          ...(job.reason === undefined ? {} : { reason: job.reason }),
        },
        run,
      )
  }
}
