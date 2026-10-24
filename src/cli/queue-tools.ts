import { errorMessage } from '../app/error-message.js'
import { submitRequest } from '../app/submit-request.js'
import type { SubmitDeps } from '../app/submit-request.js'
import { parsePullRequestRef } from '../github/pull-request-ref.js'
import type { Toolbox, ToolDefinition, ToolResult } from '../investigation/toolbox.js'
import type { HistoryStore, StatusJob } from '../store/history-store.js'
import type { JobRecord } from '../watch/types.js'
import { NOTHING_TO_WATCH } from './errors.js'
import { jobJson, NO_WATCH_WARNING, refusalText } from './format-request.js'
import { eventOfJob } from './review-event.js'

export const WAIT_DEFAULT_SECONDS = 300
export const WAIT_MAX_SECONDS = 1800
const WAIT_POLL_MS = 2_000

const WRITES = { readOnlyHint: false, openWorldHint: true }
const READS = { readOnlyHint: true, openWorldHint: false }

export interface QueueToolsDeps {
  history: HistoryStore
  submit?: SubmitDeps
  unavailable?: string
  watchRunning(): Promise<boolean>
  now(): Date
  sleep(ms: number): Promise<void>
}

const DEFINITIONS: ToolDefinition[] = [
  {
    name: 'review_pull_request',
    description:
      'Ask Phada to review a GitHub pull request. Phada decides whether the request is allowed (the repository must be watched, outside authors are refused, a commit already reviewed is not reviewed again, there is an hourly limit) and answers with the job, or with the reason it was refused. publish: "pr" posts the review on the pull request, "none" keeps it only in the answer of wait_for_job.',
    inputSchema: {
      type: 'object',
      properties: {
        pr: { type: 'string', description: 'owner/repo#N or the URL of the pull request' },
        publish: { type: 'string', enum: ['pr', 'none'], description: 'Default: pr' },
      },
      required: ['pr'],
      additionalProperties: false,
    },
    annotations: WRITES,
  },
  {
    name: 'job_status',
    description:
      'The status of a review job, its place in the queue, and its result once it ended.',
    inputSchema: {
      type: 'object',
      properties: { job: { type: 'integer' } },
      required: ['job'],
      additionalProperties: false,
    },
    annotations: READS,
  },
  {
    name: 'wait_for_job',
    description: `Wait until a review job ends and return its result: the verdict (clean, comments, blocking, failed or skipped), the link of the published review and the full review with its findings. Gives up after timeoutSeconds (default ${WAIT_DEFAULT_SECONDS}, at most ${WAIT_MAX_SECONDS}) with timedOut: true; call it again to keep waiting.`,
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'integer' },
        timeoutSeconds: { type: 'integer', minimum: 1 },
      },
      required: ['job'],
      additionalProperties: false,
    },
    annotations: READS,
  },
  {
    name: 'list_queue',
    description: 'The review jobs waiting in the queue and the one running now.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READS,
  },
]

export function queueToolbox(deps: QueueToolsDeps): Toolbox {
  return {
    definitions: DEFINITIONS,
    touchedPaths: () => [],
    call: async (name, args) => {
      try {
        const input = (typeof args === 'object' && args !== null ? args : {}) as Record<
          string,
          unknown
        >
        switch (name) {
          case 'review_pull_request':
            return await reviewPullRequest(input, deps)
          case 'job_status':
            return jobStatus(input, deps)
          case 'wait_for_job':
            return await waitForJob(input, deps)
          case 'list_queue':
            return answer({
              watchRunning: await deps.watchRunning(),
              ...queue(deps.history),
            })
          default:
            return failure(`Unknown tool ${name}.`)
        }
      } catch (error) {
        return failure(errorMessage(error))
      }
    },
  }
}

async function reviewPullRequest(
  input: Record<string, unknown>,
  deps: QueueToolsDeps,
): Promise<ToolResult> {
  if (deps.submit === undefined) return failure(deps.unavailable ?? NOTHING_TO_WATCH)
  if (typeof input.pr !== 'string') return failure('pr must be owner/repo#N or a pull request URL.')
  const publish = input.publish ?? 'pr'
  if (publish !== 'pr' && publish !== 'none') return failure('publish must be pr or none.')
  const { owner, repo, number } = parsePullRequestRef(input.pr)
  const result = await submitRequest(
    { repo: `${owner}/${repo}`, number, source: 'mcp', publish },
    deps.submit,
  )
  const watchRunning = await deps.watchRunning()
  if (result.status !== 'refused') {
    return answer({
      status: result.status,
      job: jobJson(result.job),
      watchRunning,
      ...(watchRunning ? {} : { note: NO_WATCH_WARNING }),
    })
  }
  const event = result.job === undefined ? undefined : eventOfJob(deps.history, result.job)
  return answer({
    status: 'refused',
    reason: result.reason,
    message: refusalText(result),
    ...(result.job === undefined ? {} : { job: jobJson(result.job) }),
    ...(result.until === undefined ? {} : { until: result.until }),
    ...(event === undefined ? {} : { event }),
    watchRunning,
  })
}

function jobStatus(input: Record<string, unknown>, deps: QueueToolsDeps): ToolResult {
  const found = findJob(input, deps.history)
  if ('error' in found) return failure(found.error)
  return answer(statusOf(found.job, deps.history))
}

async function waitForJob(
  input: Record<string, unknown>,
  deps: QueueToolsDeps,
): Promise<ToolResult> {
  const found = findJob(input, deps.history)
  if ('error' in found) return failure(found.error)
  const asked =
    typeof input.timeoutSeconds === 'number' ? input.timeoutSeconds : WAIT_DEFAULT_SECONDS
  const deadline = deps.now().getTime() + Math.min(Math.max(asked, 1), WAIT_MAX_SECONDS) * 1000
  let { job } = found
  for (;;) {
    const event = eventOfJob(deps.history, job)
    if (event !== undefined) {
      const newer = job.status === 'superseded' ? newerJob(job, deps.history) : undefined
      return answer({ timedOut: false, event, ...(newer === undefined ? {} : { newerJob: newer }) })
    }
    const left = deadline - deps.now().getTime()
    if (left <= 0) return answer({ timedOut: true, ...statusOf(job, deps.history) })
    await deps.sleep(Math.min(WAIT_POLL_MS, left))
    job = deps.history.job(job.id) ?? job
  }
}

function findJob(
  input: Record<string, unknown>,
  history: HistoryStore,
): { job: JobRecord } | { error: string } {
  if (typeof input.job !== 'number' || !Number.isInteger(input.job)) {
    return { error: 'job must be the id of a job.' }
  }
  const job = history.job(input.job)
  return job === undefined ? { error: `There is no job ${input.job}.` } : { job }
}

function statusOf(job: JobRecord, history: HistoryStore) {
  const { queued, running } = queue(history)
  const listed = [...queued, ...running].find(({ id }) => id === job.id)
  const index = queued.findIndex(({ id }) => id === job.id)
  const event = eventOfJob(history, job)
  return {
    job: listed ?? jobJson(job),
    ...(index === -1 ? {} : { position: index + 1 }),
    ...(event === undefined ? {} : { event }),
  }
}

function queue(history: HistoryStore) {
  const status = history.status()
  return { queued: status.queued.map(statusJob), running: status.running.map(statusJob) }
}

function statusJob(job: StatusJob) {
  return { ...jobJson(job), ...(job.sources === undefined ? {} : { sources: job.sources }) }
}

function newerJob(job: JobRecord, history: HistoryStore): number | undefined {
  return history
    .jobs({ repo: job.repo })
    .filter(({ number, id }) => number === job.number && id > job.id)
    .map(({ id }) => id)
    .sort((first, second) => second - first)[0]
}

function answer(value: unknown): ToolResult {
  return { text: JSON.stringify(value, null, 2), isError: false }
}

function failure(text: string): ToolResult {
  return { text, isError: true }
}
