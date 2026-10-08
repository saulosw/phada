import { GitHubAuthError, GitHubRateLimitError, GitHubRequestError } from './errors.js'
import type { RateLimitDetails } from './errors.js'

const API_BASE_URL = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const USER_AGENT = 'phada'
const MAX_ERROR_SNIPPET = 200
// Printable ASCII only, stricter than fetch on purpose: fetch rejects a header value with an
// inner line break or NUL using an error that quotes the value, which would leak the token.
const TOKEN_FORMAT = /^[\x21-\x7E]+$/

export const ACCEPT_JSON = 'application/vnd.github+json'
export const ACCEPT_DIFF = 'application/vnd.github.diff'

export interface GitHubRequestInit {
  method?: 'GET' | 'POST'
  body?: string
}

export interface GitHubRequestContext {
  token: string
  fetch: typeof globalThis.fetch
  timeoutMs: number
}

/** A GitHub API request (GET by default). Throws only for a malformed token, network failure or timeout. */
export async function sendGitHubRequest(
  ctx: GitHubRequestContext,
  path: string,
  accept: string,
  init: GitHubRequestInit = {},
): Promise<Response> {
  if (!TOKEN_FORMAT.test(ctx.token)) {
    throw new GitHubRequestError(
      'The GitHub token is malformed: it is empty or contains spaces or control characters.',
    )
  }
  const { fetch } = ctx
  try {
    return await fetch(`${API_BASE_URL}${path}`, {
      ...(init.method === undefined ? {} : { method: init.method }),
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        Accept: accept,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': USER_AGENT,
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(ctx.timeoutMs),
    })
  } catch (error) {
    throw toTransportError(error, ctx)
  }
}

/** Maps a non-2xx response to a typed error. Callers handle endpoint-specific statuses first. */
export async function ensureOk(response: Response, ctx: GitHubRequestContext): Promise<void> {
  if (response.ok) return

  const { status, headers } = response
  if (status === 429) throw new GitHubRateLimitError(readRateLimit(headers))
  if (status === 401 || status === 403) {
    const apiMessage = await readApiMessage(response, ctx)
    if (status === 403 && isRateLimited(headers, apiMessage)) {
      throw new GitHubRateLimitError(readRateLimit(headers))
    }
    throw new GitHubAuthError(status, apiMessage)
  }

  const snippet = await readErrorSnippet(response, ctx)
  throw new GitHubRequestError(
    `GitHub responded with HTTP ${status}${snippet === '' ? '' : `: ${snippet}`}`,
    { status },
  )
}

export async function readText(response: Response, ctx: GitHubRequestContext): Promise<string> {
  try {
    return await response.text()
  } catch (error) {
    throw toTransportError(error, ctx)
  }
}

export async function readJson(response: Response, ctx: GitHubRequestContext): Promise<unknown> {
  const text = await readText(response, ctx)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new GitHubRequestError('GitHub returned invalid JSON')
  }
}

/** The `message` of a GitHub JSON error body, redacted and truncated; undefined if absent. */
export async function readApiMessage(
  response: Response,
  ctx: GitHubRequestContext,
): Promise<string | undefined> {
  try {
    const body: unknown = JSON.parse(await response.text())
    if (
      typeof body === 'object' &&
      body !== null &&
      'message' in body &&
      typeof body.message === 'string'
    ) {
      return toErrorSnippet(body.message, ctx.token)
    }
  } catch {
    // Not JSON or unreadable: the caller still has the status to report.
  }
  return undefined
}

/** Redacts the token first, then truncates, so a token cut at the boundary never leaks. */
export function toErrorSnippet(text: string, token: string): string {
  return redact(text, token).slice(0, MAX_ERROR_SNIPPET)
}

export function redact(text: string, token: string): string {
  return token === '' ? text : text.replaceAll(token, '[REDACTED]')
}

// GitHub signals rate limits on a 403 by headers, or only by the message for some
// secondary limits.
export function isRateLimited(headers: Headers, apiMessage: string | undefined): boolean {
  return (
    headers.get('x-ratelimit-remaining') === '0' ||
    headers.has('retry-after') ||
    /rate limit/i.test(apiMessage ?? '')
  )
}

export function readRateLimit(headers: Headers): RateLimitDetails {
  const details: RateLimitDetails = {}
  const reset = parseSeconds(headers.get('x-ratelimit-reset'))
  const retryAfter = parseSeconds(headers.get('retry-after'))
  if (reset !== undefined) details.resetAt = new Date(reset * 1000)
  if (retryAfter !== undefined) details.retryAfterSeconds = retryAfter
  return details
}

function parseSeconds(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) ? seconds : undefined
}

async function readErrorSnippet(response: Response, ctx: GitHubRequestContext): Promise<string> {
  try {
    return toErrorSnippet(await response.text(), ctx.token)
  } catch {
    return ''
  }
}

function toTransportError(error: unknown, ctx: GitHubRequestContext): GitHubRequestError {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new GitHubRequestError(`GitHub did not respond within ${ctx.timeoutMs / 1000}s`)
  }
  return new GitHubRequestError('Could not reach GitHub', { cause: error })
}
