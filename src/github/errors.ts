/** Invalid user input for a pull request reference. Not a GitHub failure. */
export class InvalidPullRequestRefError extends Error {
  override readonly name = 'InvalidPullRequestRefError'
  readonly input: string

  constructor(input: string) {
    super(
      `Invalid pull request reference "${input}". ` +
        'Expected "owner/repo#123" or "https://github.com/owner/repo/pull/123".',
    )
    this.input = input
  }
}

/** Base class for every failure talking to GitHub, so callers can catch them in one place. */
export class GitHubError extends Error {
  override readonly name: string = 'GitHubError'
}

export class GitHubAuthError extends GitHubError {
  override readonly name = 'GitHubAuthError'
  readonly status: 401 | 403
  readonly apiMessage?: string

  constructor(status: 401 | 403, apiMessage?: string) {
    const summary =
      status === 401
        ? 'GitHub rejected the token (HTTP 401): it is invalid or expired.'
        : 'GitHub denied access (HTTP 403). The token may lack access to this repository.'
    super(apiMessage === undefined ? summary : `${summary} GitHub says: ${apiMessage}`)
    this.status = status
    this.apiMessage = apiMessage
  }
}

export interface RateLimitDetails {
  resetAt?: Date
  retryAfterSeconds?: number
}

export class GitHubRateLimitError extends GitHubError {
  override readonly name = 'GitHubRateLimitError'
  readonly resetAt?: Date
  readonly retryAfterSeconds?: number

  constructor(details: RateLimitDetails) {
    const hints = [
      details.resetAt && `resets at ${details.resetAt.toISOString()}`,
      details.retryAfterSeconds !== undefined && `retry after ${details.retryAfterSeconds}s`,
    ].filter(Boolean)
    super(`GitHub rate limit exceeded${hints.length > 0 ? ` (${hints.join(', ')})` : ''}.`)
    this.resetAt = details.resetAt
    this.retryAfterSeconds = details.retryAfterSeconds
  }
}

export class PullRequestNotFoundError extends GitHubError {
  override readonly name = 'PullRequestNotFoundError'
  readonly ref: string

  constructor(ref: string) {
    super(
      `Pull request ${ref} was not found. If the repository is private, check that the token can access it.`,
    )
    this.ref = ref
  }
}

export interface DiffTooLargeDetails {
  ref: string
  changedFiles: number
  bytes?: number
  maxBytes?: number
  apiMessage?: string
}

export class DiffTooLargeError extends GitHubError {
  override readonly name = 'DiffTooLargeError'
  readonly ref: string
  readonly changedFiles: number
  readonly bytes?: number
  readonly maxBytes?: number
  readonly apiMessage?: string

  constructor(details: DiffTooLargeDetails) {
    super(describeDiffTooLarge(details))
    this.ref = details.ref
    this.changedFiles = details.changedFiles
    this.bytes = details.bytes
    this.maxBytes = details.maxBytes
    this.apiMessage = details.apiMessage
  }
}

function describeDiffTooLarge(details: DiffTooLargeDetails): string {
  const { ref, changedFiles, bytes, maxBytes, apiMessage } = details
  if (bytes !== undefined && maxBytes !== undefined) {
    return `The diff of ${ref} has ${bytes} bytes (${changedFiles} changed files), above the limit of ${maxBytes} bytes.`
  }
  const reason = apiMessage === undefined ? '' : ` GitHub says: ${apiMessage}`
  return `GitHub refused to return the diff of ${ref} (${changedFiles} changed files).${reason}`
}

export interface GitHubRequestErrorOptions {
  status?: number
  cause?: unknown
}

export class GitHubRequestError extends GitHubError {
  override readonly name = 'GitHubRequestError'
  readonly status?: number

  constructor(message: string, options: GitHubRequestErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.status = options.status
  }
}
