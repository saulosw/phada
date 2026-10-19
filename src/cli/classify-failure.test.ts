import { describe, expect, it } from 'vitest'
import { ConfigError } from '../config/errors.js'
import {
  DiffTooLargeError,
  GitHubAuthError,
  GitHubGraphQLError,
  GitHubRateLimitError,
  GitHubRequestError,
  PullRequestNotFoundError,
  ReviewPermissionError,
  ReviewRejectedError,
  ReviewRepositoryAccessError,
} from '../github/errors.js'
import { ProviderError } from '../providers/types.js'
import type { ProviderErrorReason } from '../providers/types.js'
import { MirrorLockTimeoutError } from '../repository/mirror-lock.js'
import { InvalidReviewReportError } from '../review/errors.js'
import { classifyFailure } from './classify-failure.js'

const NOW = new Date('2026-10-18T12:00:00.000Z')
const provider = (reason: ProviderErrorReason) => new ProviderError('claude-cli', reason, 'x')

describe('classifyFailure', () => {
  it.each([
    ['usage-limit', 'usage-limit'],
    ['timeout', 'transient'],
    ['failed', 'transient'],
    ['invalid-output', 'definitive'],
    ['prompt-too-large', 'definitive'],
    ['not-installed', 'fatal'],
    ['not-authenticated', 'fatal'],
  ] as const)('treats a provider %s as %s', (reason, kind) => {
    expect(classifyFailure(provider(reason), NOW)).toEqual({ kind })
  })

  it('pauses until the GitHub rate limit resets', () => {
    const error = new GitHubRateLimitError({ retryAfterSeconds: 60 })

    expect(classifyFailure(error, NOW)).toEqual({
      kind: 'rate-limit',
      resetAt: '2026-10-18T12:01:00.000Z',
    })
  })

  it.each([
    ['a GitHub 502', new GitHubRequestError('bad gateway', { status: 502 })],
    ['a request without a status', new GitHubRequestError('timed out')],
    ['a GraphQL error', new GitHubGraphQLError('Something went wrong')],
    ['a network failure', new TypeError('fetch failed')],
    ['a busy mirror', new MirrorLockTimeoutError('/cache/x.lock')],
  ])('retries %s', (_case, error) => {
    expect(classifyFailure(error, NOW)).toEqual({ kind: 'transient' })
  })

  it('stops the watch on a token GitHub does not accept', () => {
    expect(classifyFailure(new GitHubAuthError(401), NOW)).toEqual({ kind: 'fatal' })
  })

  it.each([
    ['a GitHub 403', new GitHubAuthError(403)],
    ['a GitHub 404 status', new GitHubRequestError('not found', { status: 404 })],
    ['a missing pull request', new PullRequestNotFoundError('acme/shop#3')],
    ['a diff too large', new DiffTooLargeError({ ref: 'acme/shop#3', changedFiles: 4000 })],
    ['no permission to publish', new ReviewPermissionError('acme/shop#3')],
    ['no access to publish', new ReviewRepositoryAccessError('acme/shop#3')],
    ['a rejected review', new ReviewRejectedError('acme/shop#3', 'too long')],
    ['an invalid review', new InvalidReviewReportError('no report', '')],
    ['a broken config', new ConfigError('Invalid config')],
    ['anything else', new Error('boom')],
  ])('fails the job on %s', (_case, error) => {
    expect(classifyFailure(error, NOW)).toEqual({ kind: 'definitive' })
  })
})
