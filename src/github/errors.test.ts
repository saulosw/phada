import { describe, expect, it } from 'vitest'
import {
  DiffTooLargeError,
  GitHubAuthError,
  GitHubError,
  GitHubRateLimitError,
  GitHubRequestError,
  PullRequestNotFoundError,
} from './errors.js'

describe('GitHub errors', () => {
  it.each([
    [new GitHubError('boom'), 'GitHubError', 'boom'],
    [
      new GitHubAuthError(401),
      'GitHubAuthError',
      'GitHub rejected the token (HTTP 401): it is invalid or expired.',
    ],
    [
      new GitHubAuthError(401, 'Bad credentials'),
      'GitHubAuthError',
      'GitHub rejected the token (HTTP 401): it is invalid or expired. GitHub says: Bad credentials',
    ],
    [
      new GitHubAuthError(403),
      'GitHubAuthError',
      'GitHub denied access (HTTP 403). The token may lack access to this repository.',
    ],
    [new GitHubRateLimitError({}), 'GitHubRateLimitError', 'GitHub rate limit exceeded.'],
    [
      new GitHubRateLimitError({ resetAt: new Date(0), retryAfterSeconds: 60 }),
      'GitHubRateLimitError',
      'GitHub rate limit exceeded (resets at 1970-01-01T00:00:00.000Z, retry after 60s).',
    ],
    [
      new PullRequestNotFoundError('saulosw/phada#12'),
      'PullRequestNotFoundError',
      'Pull request saulosw/phada#12 was not found. If the repository is private, check that the token can access it.',
    ],
    [
      new DiffTooLargeError({ ref: 'saulosw/phada#12', changedFiles: 400 }),
      'DiffTooLargeError',
      'GitHub refused to return the diff of saulosw/phada#12 (400 changed files).',
    ],
    [
      new GitHubRequestError('Could not reach GitHub'),
      'GitHubRequestError',
      'Could not reach GitHub',
    ],
  ])('%s has a stable name and message and shares the GitHubError base', (error, name, message) => {
    expect(error).toBeInstanceOf(GitHubError)
    expect(error.name).toBe(name)
    expect(error.message).toBe(message)
  })

  it('only defines a cause when one is given', () => {
    const cause = new TypeError('fetch failed')

    expect('cause' in new GitHubRequestError('no cause')).toBe(false)
    expect(new GitHubRequestError('with cause', { cause }).cause).toBe(cause)
  })
})
