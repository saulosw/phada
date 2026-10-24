import type { WatchedRepoSettings } from '../config/watch-settings.js'
import { TRUSTED_ASSOCIATIONS } from './filters.js'
import { RATE_WINDOW_MS } from './next-job.js'
import { later } from './time.js'
import type { JobRecord, PublishTarget, RequestSource } from './types.js'

export type RefusalReason =
  'not-watched' | 'closed' | 'external' | 'when-command' | 'already-reviewed' | 'hourly-limit'

export interface PullFacts {
  repo: string
  number: number
  headSha: string
  state: 'open' | 'closed'
  private: boolean
  association: string
  author?: string
  draft?: boolean
  baseRef?: string
  title?: string
  labels?: string[]
}

export interface PolicyInput {
  request: { source: RequestSource; publish: PublishTarget }
  repo?: WatchedRepoSettings
  pull: PullFacts
  jobs: readonly JobRecord[]
  createdLastHour: readonly string[]
  maxPerHour: number
  now: string
  whenRefusal?: string
}

export type RequestDecision =
  | { action: 'create'; job: Omit<JobRecord, 'id'> }
  | { action: 'join'; jobId: number; readyNow: boolean }
  | { action: 'refuse'; reason: RefusalReason; jobId?: number; until?: string; message?: string }

const REVIEWED_SKIPS: ReadonlySet<string> = new Set(['already-reviewed', 'same-diff'])

export function decideRequest(input: PolicyInput): RequestDecision {
  const { repo, pull, request, now } = input
  if (repo === undefined) return { action: 'refuse', reason: 'not-watched' }
  const gate = gateRefusal(repo, pull)
  if (gate !== undefined) return { action: 'refuse', reason: gate }
  if (input.whenRefusal !== undefined) {
    return { action: 'refuse', reason: 'when-command', message: input.whenRefusal }
  }
  const sameCommit = input.jobs.filter(
    (job) => job.number === pull.number && job.headSha === pull.headSha,
  )
  const satisfies = (job: JobRecord) => request.publish === 'none' || publishOf(job) === 'pr'
  const queued = sameCommit.find((job) => job.status === 'queued')
  if (queued !== undefined) return { action: 'join', jobId: queued.id, readyNow: true }
  const running = sameCommit.find((job) => job.status === 'running' && satisfies(job))
  if (running !== undefined) return { action: 'join', jobId: running.id, readyNow: false }
  const reviewed = sameCommit.find((job) => reviewedCommit(job) && satisfies(job))
  if (reviewed !== undefined) {
    return { action: 'refuse', reason: 'already-reviewed', jobId: reviewed.id }
  }
  const recent = [...input.createdLastHour].sort()
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

export function gateRefusal(
  repo: WatchedRepoSettings,
  pull: PullFacts,
): 'closed' | 'external' | undefined {
  if (pull.state === 'closed') return 'closed'
  if (!pull.private && !repo.allowExternal && !TRUSTED_ASSOCIATIONS.has(pull.association)) {
    return 'external'
  }
  return undefined
}

export function publishOf(job: JobRecord): PublishTarget {
  return job.publish ?? 'pr'
}

function reviewedCommit(job: JobRecord): boolean {
  return (
    job.status === 'done' ||
    (job.status === 'skipped' && job.reason !== undefined && REVIEWED_SKIPS.has(job.reason))
  )
}
