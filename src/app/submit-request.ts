import type { WatchSettings } from '../config/watch-settings.js'
import type { HistoryStore } from '../store/history-store.js'
import { RATE_WINDOW_MS } from '../watch/next-job.js'
import { decideRequest } from '../watch/request-policy.js'
import type { PullFacts, RefusalReason } from '../watch/request-policy.js'
import { later } from '../watch/time.js'
import type { JobRecord, PublishTarget, RequestSource } from '../watch/types.js'

export interface ReviewRequestInput {
  repo: string
  number: number
  source: RequestSource
  publish: PublishTarget
  data?: Record<string, unknown>
}

export interface SubmitDeps {
  history: HistoryStore
  settings: WatchSettings
  readPull(repo: string, number: number): Promise<PullFacts>
  now(): Date
}

export type SubmitResult =
  | { status: 'queued' | 'joined'; job: JobRecord; requestId: number }
  | { status: 'refused'; reason: RefusalReason; job?: JobRecord; until?: string }

export async function submitRequest(
  input: ReviewRequestInput,
  deps: SubmitDeps,
): Promise<SubmitResult> {
  const repoName = input.repo.toLowerCase()
  const repo = deps.settings.repos.find((entry) => entry.repo === repoName)
  if (repo === undefined) return { status: 'refused', reason: 'not-watched' }
  const pull = await deps.readPull(repoName, input.number)
  const { history } = deps
  return history.transaction(() => {
    const now = deps.now().toISOString()
    const jobs = history.jobs({ repo: repoName })
    const decision = decideRequest({
      request: { source: input.source, publish: input.publish },
      repo,
      pull: { ...pull, repo: repoName },
      jobs,
      createdLastHour: history.jobsCreatedSince(later(now, -RATE_WINDOW_MS)),
      maxPerHour: deps.settings.maxReviewsPerHour,
      now,
    })
    if (decision.action === 'refuse') {
      const job = jobs.find(({ id }) => id === decision.jobId)
      return {
        status: 'refused',
        reason: decision.reason,
        ...(job === undefined ? {} : { job }),
        ...(decision.until === undefined ? {} : { until: decision.until }),
      }
    }
    const request = {
      source: input.source,
      publish: input.publish,
      ...(input.data === undefined ? {} : { data: input.data }),
      createdAt: now,
    }
    if (decision.action === 'create') {
      const id = history.addJob(decision.job)
      const requestId = history.addRequest({ ...request, jobId: id })
      return { status: 'queued', job: { ...decision.job, id }, requestId }
    }
    const existing = jobs.find(({ id }) => id === decision.jobId)!
    const changes: Partial<JobRecord> = {
      ...(decision.readyNow && existing.notBefore > now ? { notBefore: now } : {}),
      ...(input.publish === 'pr' && existing.publish === 'none' ? { publish: 'pr' } : {}),
    }
    history.updateJob(existing.id, changes)
    const requestId = history.addRequest({ ...request, jobId: existing.id })
    return { status: 'joined', job: { ...existing, ...changes }, requestId }
  })
}
