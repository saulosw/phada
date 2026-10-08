import {
  GitHubRateLimitError,
  ReviewPermissionError,
  ReviewRejectedError,
  ReviewRepositoryAccessError,
} from './errors.js'
import { isRecord, stringField } from './json-fields.js'
import { formatPullRequestRef } from './pull-request-ref.js'
import type { PullRequestRef } from './pull-request-ref.js'
import {
  ACCEPT_JSON,
  ensureOk,
  isRateLimited,
  readApiMessage,
  readJson,
  readRateLimit,
  readText,
  sendGitHubRequest,
  toErrorSnippet,
} from './request.js'
import type { GitHubRequestContext } from './request.js'

const DEFAULT_TIMEOUT_MS = 30_000

export interface ReviewComment {
  path: string
  line: number
  body: string
}

export interface CreateReviewOptions extends PullRequestRef {
  token: string
  commitSha: string
  body: string
  comments: readonly ReviewComment[]
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export interface CreatedReview {
  url: string
}

export async function createReview(options: CreateReviewOptions): Promise<CreatedReview> {
  const { owner, repo, number } = options
  const ref = formatPullRequestRef({ owner, repo, number })
  const ctx: GitHubRequestContext = {
    token: options.token,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/reviews`
  const payload = {
    commit_id: options.commitSha,
    event: 'COMMENT',
    body: options.body,
    comments: options.comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      side: 'RIGHT',
      body: comment.body,
    })),
  }
  const response = await sendGitHubRequest(ctx, path, ACCEPT_JSON, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  if (response.status === 403) {
    const apiMessage = await readApiMessage(response, ctx)
    if (isRateLimited(response.headers, apiMessage)) {
      throw new GitHubRateLimitError(readRateLimit(response.headers))
    }
    throw new ReviewPermissionError(ref, apiMessage)
  }
  if (response.status === 404) throw new ReviewRepositoryAccessError(ref)
  if (response.status === 422)
    throw new ReviewRejectedError(ref, await readRejection(response, ctx))
  await ensureOk(response, ctx)
  return { url: stringField(await readJson(response, ctx), 'html_url') }
}

async function readRejection(
  response: Response,
  ctx: GitHubRequestContext,
): Promise<string | undefined> {
  try {
    const body: unknown = JSON.parse(await readText(response, ctx))
    if (!isRecord(body)) return undefined
    const errors = Array.isArray(body.errors) ? body.errors.map(errorText) : []
    const parts = [typeof body.message === 'string' ? body.message : '', ...errors]
    const text = parts.filter((part) => part !== '').join('; ')
    return text === '' ? undefined : toErrorSnippet(text, ctx.token)
  } catch {
    return undefined
  }
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  return isRecord(error) && typeof error.message === 'string' ? error.message : ''
}
