import type { WatchedRepoSettings } from '../config/watch-settings.js'
import { TRUSTED_ASSOCIATIONS } from './filters.js'
import { notStarted, RATE_WINDOW_MS } from './next-job.js'
import { later } from './time.js'
import type { PullFacts } from './pull-facts.js'
import type { JobRecord, PublishTarget, RequestSource } from './types.js'

export type RefusalReason =
  'not-watched' | 'closed' | 'external' | 'when-command' | 'already-reviewed' | 'hourly-limit'

export interface PolicyInput {
  request: { source: RequestSource; publish: PublishTarget }
  repo: WatchedRepoSettings
  pull: PullFacts
  jobs: readonly JobRecord[]
  creationTimesLastHour: readonly string[]
  maxPerHour: number
  now: string
  when?: { refusal?: string }
}

export type RequestDecision =
  | { action: 'create'; job: Omit<JobRecord, 'id'> }
  | { action: 'join'; jobId: number; readyNow: boolean }
  | { action: 'ask-when' }
  | { action: 'refuse'; reason: RefusalReason; jobId?: number; until?: string; message?: string }

const REVIEWED_SKIPS: ReadonlySet<string> = new Set(['already-reviewed', 'same-diff'])

export function decideRequest(input: PolicyInput): RequestDecision {
  const { repo, pull, request, now } = input
  const gate = gateRefusal(repo, pull)
  if (gate !== undefined) return { action: 'refuse', reason: gate }
  const sameCommit = input.jobs.filter(
    (job) => job.number === pull.number && job.headSha === pull.headSha,
  )
  const satisfies = (job: JobRecord) => request.publish === 'none' || publishOf(job, repo) === 'pr'
  const waiting = sameCommit.find(notStarted)
  if (waiting !== undefined) return { action: 'join', jobId: waiting.id, readyNow: true }
  const running = sameCommit.find((job) => job.status === 'running' && satisfies(job))
  if (running !== undefined) return { action: 'join', jobId: running.id, readyNow: false }
  const reviewed = sameCommit.find((job) => reviewedCommit(job) && satisfies(job))
  if (reviewed !== undefined) {
    return { action: 'refuse', reason: 'already-reviewed', jobId: reviewed.id }
  }
  if (repo.when !== undefined && input.when === undefined) return { action: 'ask-when' }
  if (input.when?.refusal !== undefined) {
    return { action: 'refuse', reason: 'when-command', message: input.when.refusal }
  }
  const recent = [...input.creationTimesLastHour].sort()
  if (recent.length >= input.maxPerHour) {
    const oldest = recent[recent.length - input.maxPerHour] ?? now
    return { action: 'refuse', reason: 'hourly-limit', until: later(oldest, RATE_WINDOW_MS) }
  }
  return {
    action: 'create',
    job: {
      repo: repo.repo,
      number: pull.number,
      headSha: pull.headSha,
      status: 'queued',
      attempts: 0,
      notBefore: now,
      publish: request.publish,
      createdAt: now,
    },
  }
}

function gateRefusal(
  repo: WatchedRepoSettings,
  pull: PullFacts,
): 'closed' | 'external' | undefined {
  if (pull.state === 'closed') return 'closed'
  if (!pull.private && !repo.allowExternal && !TRUSTED_ASSOCIATIONS.has(pull.association)) {
    return 'external'
  }
  return undefined
}

export function publishOf(job: JobRecord, repo: WatchedRepoSettings): PublishTarget {
  return job.publish ?? repo.publish
}

function reviewedCommit(job: JobRecord): boolean {
  return (
    job.status === 'done' ||
    (job.status === 'skipped' && job.reason !== undefined && REVIEWED_SKIPS.has(job.reason))
  )
}
