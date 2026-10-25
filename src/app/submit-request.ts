import type { WatchSettings } from '../config/watch-settings.js'
import type { HistoryStore } from '../store/history-store.js'
import { requeueForCi } from '../watch/ci-revisit.js'
import { RATE_WINDOW_MS } from '../watch/next-job.js'
import type { PullFacts } from '../watch/pull-facts.js'
import { decideRequest } from '../watch/request-policy.js'
import type { PolicyInput, RefusalReason } from '../watch/request-policy.js'
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
  const { history } = deps
  const policyInput = (when?: PolicyInput['when']): PolicyInput => {
    const now = deps.now().toISOString()
    return {
      request: { source: input.source, publish: input.publish },
      repo,
      pull,
      jobs: history.jobs({ repo: repoName }),
      creationTimesLastHour: history.jobCreationTimesSince(later(now, -RATE_WINDOW_MS)),
      maxPerHour: deps.settings.maxReviewsPerHour,
      now,
      ...(when === undefined ? {} : { when }),
    }
  }
  const when =
    decideRequest(policyInput()).action === 'ask-when' && repo.when !== undefined
      ? { ...(await askWhen(repo.when, pull, input, deps)) }
      : undefined
  return history.transaction(() => {
    const decided = policyInput(when ?? {})
    const { now, jobs } = decided
    const decision = decideRequest(decided)
    if (decision.action === 'ask-when') throw new Error('the when command was not asked')
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
      ...(decision.requeue === true ? requeueForCi(now) : {}),
      ...(input.publish === 'pr' && existing.publish === 'none' ? { publish: 'pr' } : {}),
    }
    history.updateJob(existing.id, changes)
    const requestId = history.addRequest({ ...request, jobId: existing.id })
    return { status: 'joined', job: { ...existing, ...changes }, requestId }
  })
}

async function askWhen(
  command: string,
  pull: PullFacts,
  input: ReviewRequestInput,
  deps: SubmitDeps,
): Promise<{ refusal?: string }> {
  const refusal = await deps.checkWhen?.(command, whenInput(pull, input))
  return refusal === undefined ? {} : { refusal }
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
