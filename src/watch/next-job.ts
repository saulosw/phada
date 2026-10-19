import type { JobRecord, PauseState } from '../store/history-store.js'
import { later } from './failures.js'

export const RATE_WINDOW_MS = 3_600_000

export interface NextJobInput {
  queued: readonly JobRecord[]
  now: string
  pause?: PauseState
  watchRunsLastHour: readonly string[]
  maxPerHour: number
}

export type WaitReason = 'not-ready' | 'paused' | 'hourly-limit'

export type NextJob = { job: JobRecord } | { waitUntil?: string; reason?: WaitReason }

export function pickNext(input: NextJobInput): NextJob {
  const { queued, now, pause } = input
  if (queued.length === 0) return {}
  if (pause !== undefined && pause.until > now) return { waitUntil: pause.until, reason: 'paused' }
  const recent = [...input.watchRunsLastHour].sort()
  if (recent.length >= input.maxPerHour) {
    const oldest = recent[recent.length - input.maxPerHour] ?? now
    return { waitUntil: later(oldest, RATE_WINDOW_MS), reason: 'hourly-limit' }
  }
  const ordered = [...queued].sort(
    (first, second) =>
      compareText(first.notBefore, second.notBefore) ||
      compareText(first.createdAt, second.createdAt) ||
      first.id - second.id,
  )
  const first = ordered[0]
  if (first === undefined) return {}
  return first.notBefore <= now
    ? { job: first }
    : { waitUntil: first.notBefore, reason: 'not-ready' }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
