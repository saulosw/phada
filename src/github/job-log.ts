import { GitHubError, GitHubRequestError } from './errors.js'
import type { RepositoryFilesOptions } from './repository-files.js'
import { ACCEPT_JSON, ensureReadable, readText, sendGitHubRequest } from './request.js'
import type { GitHubRequestContext, ReadPermission } from './request.js'

const DEFAULT_TIMEOUT_MS = 30_000
export const JOB_LOG_TAIL_BYTES = 512 * 1024
export const JOB_LOG_LIMIT_BYTES = 10 * 1024 * 1024
const LOGS: ReadPermission = { what: 'the job logs', permission: 'actions:read' }
const GONE: ReadonlySet<number> = new Set([403, 404, 410])
const FROM_START = /^bytes 0-/

export interface JobLog {
  text: string
  partial: boolean
}

export class JobLogUnavailableError extends GitHubError {
  override readonly name = 'JobLogUnavailableError'

  constructor(jobId: number) {
    super(`The log of job ${jobId} is not available (expired or deleted)`)
  }
}

export class JobLogTooLargeError extends GitHubError {
  override readonly name = 'JobLogTooLargeError'

  constructor(jobId: number) {
    super(
      `The log of job ${jobId} is above ${JOB_LOG_LIMIT_BYTES / 1024 / 1024} MB and the server did not send only its end`,
    )
  }
}

export async function fetchJobLog(
  options: RepositoryFilesOptions & { jobId: number },
): Promise<JobLog> {
  const ctx: GitHubRequestContext = {
    token: options.token,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  const repo = `${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`
  const response = await sendGitHubRequest(
    ctx,
    `/repos/${repo}/actions/jobs/${options.jobId}/logs`,
    ACCEPT_JSON,
    { redirect: 'manual' },
  )
  if (response.status === 404 || response.status === 410) {
    throw new JobLogUnavailableError(options.jobId)
  }
  if (response.status >= 300 && response.status < 400) {
    return readBlob(ctx, blobUrl(response.headers.get('location')), options.jobId)
  }
  await ensureReadable(response, ctx, LOGS)
  return tailOf(response, options.jobId)
}

function blobUrl(location: string | null): string {
  const url = location === null ? undefined : URL.parse(location)
  if (url?.protocol !== 'https:') {
    throw new GitHubRequestError('GitHub redirected the job log to a link that is not https')
  }
  return url.href
}

async function readBlob(ctx: GitHubRequestContext, url: string, jobId: number): Promise<JobLog> {
  let response: Response
  try {
    response = await ctx.fetch(url, {
      headers: { Range: `bytes=-${JOB_LOG_TAIL_BYTES}` },
      signal: AbortSignal.timeout(ctx.timeoutMs),
    })
  } catch (error) {
    throw new GitHubRequestError('Could not download the job log', { cause: error })
  }
  if (GONE.has(response.status)) throw new JobLogUnavailableError(jobId)
  if (response.status === 416) return { text: '', partial: false }
  if (response.status === 206) {
    const range = response.headers.get('content-range') ?? ''
    return { text: await readText(response, ctx), partial: !FROM_START.test(range) }
  }
  if (!response.ok) {
    throw new GitHubRequestError(`The job log download answered HTTP ${response.status}`, {
      status: response.status,
    })
  }
  return tailOf(response, jobId)
}

async function tailOf(response: Response, jobId: number): Promise<JobLog> {
  const reader = response.body?.getReader()
  if (reader === undefined) return { text: '', partial: false }
  const chunks: Uint8Array[] = []
  let kept = 0
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > JOB_LOG_LIMIT_BYTES) {
      await reader.cancel()
      throw new JobLogTooLargeError(jobId)
    }
    chunks.push(value)
    kept += value.length
    while (chunks.length > 1 && kept - (chunks[0]?.length ?? 0) >= JOB_LOG_TAIL_BYTES) {
      kept -= chunks.shift()?.length ?? 0
    }
  }
  const bytes = new Uint8Array(kept)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  const tail = bytes.slice(Math.max(0, kept - JOB_LOG_TAIL_BYTES))
  return { text: new TextDecoder().decode(tail), partial: total > JOB_LOG_TAIL_BYTES }
}
