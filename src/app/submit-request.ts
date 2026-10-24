import type { WatchSettings } from '../config/watch-settings.js'
import type { HistoryStore } from '../store/history-store.js'
import { RATE_WINDOW_MS } from '../watch/next-job.js'
import { decideRequest, gateRefusal } from '../watch/request-policy.js'
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
  checkWhen?(command: string, input: WhenInput): Promise<string | undefined>
  now(): Date
}

export interface WhenInput {
  schemaVersion: 1
  pullRequest: PullFacts & { url: string }
  request: { source: RequestSource; publish: PublishTarget; data?: Record<string, unknown> }
}

export type SubmitResult =
  | { status: 'queued' | 'joined'; job: JobRecord; requestId: number }
  | {
      status: 'refused'
      reason: RefusalReason
      job?: JobRecord
      until?: string
      message?: string
    }

export async function submitRequest(
  input: ReviewRequestInput,
  deps: SubmitDeps,
): Promise<SubmitResult> {
  const repoName = input.repo.toLowerCase()
  const repo = deps.settings.repos.find((entry) => entry.repo === repoName)
  if (repo === undefined) return { status: 'refused', reason: 'not-watched' }
  const pull = { ...(await deps.readPull(repoName, input.number)), repo: repoName }
  const whenRefusal =
    repo.when === undefined || deps.checkWhen === undefined || gateRefusal(repo, pull) !== undefined
      ? undefined
      : await deps.checkWhen(repo.when, whenInput(pull, input))
  const { history } = deps
  return history.transaction(() => {
    const now = deps.now().toISOString()
    const jobs = history.jobs({ repo: repoName })
    const decision = decideRequest({
      request: { source: input.source, publish: input.publish },
      repo,
      pull,
      jobs,
      createdLastHour: history.jobsCreatedSince(later(now, -RATE_WINDOW_MS)),
      maxPerHour: deps.settings.maxReviewsPerHour,
      now,
      ...(whenRefusal === undefined ? {} : { whenRefusal }),
    })
    const existing =
      decision.action === 'create' ? undefined : jobs.find(({ id }) => id === decision.jobId)
    if (decision.action === 'refuse') {
      return {
        status: 'refused',
        reason: decision.reason,
        ...(existing === undefined ? {} : { job: existing }),
        ...(decision.until === undefined ? {} : { until: decision.until }),
        ...(decision.message === undefined ? {} : { message: decision.message }),
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
    if (existing === undefined) throw new Error(`job ${decision.jobId} is not in the queue`)
    const changes: Partial<JobRecord> = {
      ...(decision.readyNow && existing.notBefore > now ? { notBefore: now } : {}),
      ...(input.publish === 'pr' && existing.publish === 'none' ? { publish: 'pr' } : {}),
    }
    history.updateJob(existing.id, changes)
    const requestId = history.addRequest({ ...request, jobId: existing.id })
    return { status: 'joined', job: { ...existing, ...changes }, requestId }
  })
}

export function whenInput(
  pull: PullFacts,
  request: Pick<ReviewRequestInput, 'source' | 'publish' | 'data'>,
): WhenInput {
  return {
    schemaVersion: 1,
    pullRequest: { ...pull, url: `https://github.com/${pull.repo}/pull/${pull.number}` },
    request: {
      source: request.source,
      publish: request.publish,
      ...(request.data === undefined ? {} : { data: request.data }),
    },
  }
}
