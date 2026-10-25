import type { CiSummary } from '../context/types.js'
import { later } from './time.js'

export const CI_PENDING = 'ci-pending'
export const NO_CHECKS_GRACE_MS = 120_000
export const CI_RECHECK_MS = 60_000

export type CiFailurePolicy = 'review' | 'skip'

export interface CiGateInput {
  ci: Pick<CiSummary, 'state' | 'pending' | 'failing'>
  waitMs: number
  onFailure: CiFailurePolicy
  seenAt: string
  now: string
}

export type CiGate =
  | { action: 'review'; pending?: string[] }
  | { action: 'wait'; until: string; deadline: string; pending: string[] }
  | { action: 'skip'; failing: string[] }

export function ciGate(input: CiGateInput): CiGate {
  const { ci, now, seenAt } = input
  if (ci.state === 'failing') {
    return input.onFailure === 'skip'
      ? { action: 'skip', failing: [...ci.failing] }
      : review(ci.pending)
  }
  if (ci.state === 'passing') return { action: 'review' }
  const deadline = later(seenAt, input.waitMs)
  if (now >= deadline) return review(ci.pending)
  if (ci.state === 'none') {
    const appear = later(seenAt, NO_CHECKS_GRACE_MS)
    if (now >= appear) return { action: 'review' }
    const until = earliest(appear, deadline)
    return { action: 'wait', until, deadline: until, pending: [] }
  }
  return {
    action: 'wait',
    until: earliest(later(now, CI_RECHECK_MS), deadline),
    deadline,
    pending: [...ci.pending],
  }
}

function review(pending: readonly string[]): CiGate {
  return pending.length === 0 ? { action: 'review' } : { action: 'review', pending: [...pending] }
}

function earliest(first: string, second: string): string {
  return first < second ? first : second
}
