import { describe, expect, it, vi } from 'vitest'
import {
  DiffTooLargeError,
  GitHubAuthError,
  GitHubRateLimitError,
  GitHubRequestError,
  InvalidPullRequestRefError,
  PullRequestNotFoundError,
} from '../github/errors.js'
import { ProviderError } from '../providers/types.js'
import { MissingGitHubTokenError, UsageError } from './errors.js'
import { formatError } from './format-error.js'

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`

function format(error: unknown, debug = false) {
  return formatError(error, { debug })
}

describe('formatError', () => {
  it.each([
    [
      new UsageError('Missing the pull request to review.'),
      'phada: Missing the pull request to review. Run with --help for usage.',
      2,
    ],
    [
      new InvalidPullRequestRefError('acme/shop'),
      'phada: Invalid pull request reference "acme/shop". Expected "owner/repo#123" or "https://github.com/owner/repo/pull/123".',
      2,
    ],
    [
      new MissingGitHubTokenError(),
      'phada: GITHUB_TOKEN is not set. Run: export GITHUB_TOKEN=$(gh auth token)',
      1,
    ],
    [
      new GitHubAuthError(401),
      'phada: GitHub rejected the token (HTTP 401): it is invalid or expired.',
      1,
    ],
    [
      new GitHubRateLimitError({ resetAt: new Date('2026-10-03T12:00:00Z') }),
      'phada: GitHub rate limit exceeded (resets at 2026-10-03T12:00:00.000Z).',
      1,
    ],
    [
      new PullRequestNotFoundError('acme/shop#12'),
      'phada: Pull request acme/shop#12 was not found. If the repository is private, check that the token can access it.',
      1,
    ],
    [
      new GitHubRequestError('GitHub responded with HTTP 502'),
      'phada: GitHub responded with HTTP 502',
      1,
    ],
    [
      new DiffTooLargeError({ ref: 'acme/shop#12', changedFiles: 659, apiMessage: 'too big' }),
      'phada: GitHub refused to return the diff of acme/shop#12 (659 changed files). GitHub says: too big Phada never truncates a diff.',
      1,
    ],
    [
      new ProviderError(
        'claude-cli',
        'not-installed',
        'Claude Code was not found (command "claude").',
      ),
      'phada: Claude Code is not installed: https://code.claude.com',
      1,
    ],
    [
      new ProviderError(
        'claude-cli',
        'not-authenticated',
        'Claude returned an error: Not logged in',
      ),
      'phada: Claude Code is not logged in. Run "claude" and then /login.',
      1,
    ],
    [
      new ProviderError('codex-cli', 'not-installed', 'Codex CLI was not found (command "codex").'),
      'phada: Codex CLI is not installed: npm i -g @openai/codex',
      1,
    ],
    [
      new ProviderError('codex-cli', 'not-authenticated', 'Codex exited with code 1: 401'),
      'phada: Codex CLI is not logged in. Run "codex login".',
      1,
    ],
    [
      new ProviderError('claude-cli', 'timeout', 'Claude did not answer within 600s.'),
      'phada: Claude did not answer within 600s.',
      1,
    ],
    [
      new ProviderError('other-cli', 'not-authenticated', 'Other CLI is logged out.'),
      'phada: Other CLI is logged out.',
      1,
    ],
    [
      new Error('Something broke.'),
      'phada: Unexpected error: Something broke. Run with --debug for details.',
      1,
    ],
    ['plain string', 'phada: Unexpected error: plain string. Run with --debug for details.', 1],
  ])('formats %s as one line with its exit code', (error, message, exitCode) => {
    expect(format(error)).toEqual({ message, exitCode })
  })

  it('keeps the message on one line and strips control characters', () => {
    const error = new ProviderError('claude-cli', 'failed', 'Claude said:\n\u001B[31mboom\u001B[0m')

    expect(format(error).message).toBe('phada: Claude said: [31mboom[0m')
  })

  it('adds the stack and the cause chain only in debug mode', () => {
    const cause = new TypeError('fetch failed')
    const error = new GitHubRequestError('Could not reach GitHub', { cause })

    const quiet = format(error).message
    const debug = format(error, true).message

    expect(quiet).toBe('phada: Could not reach GitHub')
    expect(
      debug.startsWith(
        'phada: Could not reach GitHub\nGitHubRequestError: Could not reach GitHub\n',
      ),
    ).toBe(true)
    expect(debug).toContain('Caused by: TypeError: fetch failed')
  })

  it('never prints the GitHub token from the environment', () => {
    vi.stubEnv('GITHUB_TOKEN', TOKEN)
    try {
      const outputs = [new MissingGitHubTokenError(), new GitHubAuthError(401)].flatMap((error) => [
        format(error).message,
        format(error, true).message,
      ])

      for (const output of outputs) expect(output).not.toContain(TOKEN)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
