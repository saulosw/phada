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

export type NextJob = { job: JobRecord } | { waitUntil?: string }

export function pickNext(input: NextJobInput): NextJob {
  const { queued, now, pause } = input
  if (queued.length === 0) return {}
  if (pause !== undefined && pause.until > now) return { waitUntil: pause.until }
  const recent = [...input.watchRunsLastHour].sort()
  if (recent.length >= input.maxPerHour) {
    const oldest = recent[recent.length - input.maxPerHour] ?? now
    return { waitUntil: later(oldest, RATE_WINDOW_MS) }
  }
  const ordered = [...queued].sort(
    (a, b) => compare(a.notBefore, b.notBefore) || compare(a.createdAt, b.createdAt) || a.id - b.id,
  )
  const first = ordered[0]
  if (first === undefined) return {}
  return first.notBefore <= now ? { job: first } : { waitUntil: first.notBefore }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
