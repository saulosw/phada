import type { FailureKind, JobRecord, PauseState } from '../store/history-store.js'

export const MAX_ATTEMPTS = 3
export const RETRY_DELAYS_MS: readonly number[] = [60_000, 300_000]
export const USAGE_PAUSE_MS: readonly number[] = [900_000, 1_800_000, 3_600_000, 7_200_000]
export const RATE_LIMIT_MARGIN_MS = 5_000
export const RATE_LIMIT_FALLBACK_MS = 900_000

export interface FailureInput {
  job: JobRecord
  kind: FailureKind
  now: string
  pause?: PauseState
  resetAt?: string
}

export interface FailureOutcome {
  job: Partial<Omit<JobRecord, 'id'>>
  pause?: PauseState
  stop?: true
}

export function afterFailure({ job, kind, now, pause, resetAt }: FailureInput): FailureOutcome {
  switch (kind) {
    case 'transient': {
      const attempts = job.attempts + 1
      const delay = RETRY_DELAYS_MS[attempts - 1]
      if (attempts >= MAX_ATTEMPTS || delay === undefined) {
        return { job: { status: 'failed', attempts, errorKind: kind, finishedAt: now } }
      }
      return { job: { status: 'queued', attempts, notBefore: later(now, delay), errorKind: kind } }
    }
    case 'usage-limit': {
      const streak = pause?.reason === kind ? pause.streak + 1 : 1
      const delay = USAGE_PAUSE_MS[Math.min(streak, USAGE_PAUSE_MS.length) - 1] ?? 0
      return {
        job: { status: 'queued', errorKind: kind },
        pause: { until: later(now, delay), reason: kind, streak },
      }
    }
    case 'rate-limit': {
      const until =
        resetAt === undefined
          ? later(now, RATE_LIMIT_FALLBACK_MS)
          : later(resetAt, RATE_LIMIT_MARGIN_MS)
      return {
        job: { status: 'queued', errorKind: kind },
        pause: { until, reason: kind, streak: 1 },
      }
    }
    case 'definitive':
      return {
        job: { status: 'failed', attempts: job.attempts + 1, errorKind: kind, finishedAt: now },
      }
    case 'fatal':
      return { job: { status: 'queued', errorKind: kind }, stop: true }
  }
}

export function later(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString()
}
