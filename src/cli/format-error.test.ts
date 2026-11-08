import { describe, expect, it, vi } from 'vitest'
import {
  InvalidLessonEditError,
  LessonDecidedError,
  LessonNotFoundError,
  LessonRuleRefusedError,
} from '../app/decide-lesson.js'
import { ConfigError } from '../config/errors.js'
import { SkillError } from '../skills/errors.js'
import { EditorNotFoundError } from './text-editor.js'
import {
  DiffTooLargeError,
  GitHubAuthError,
  GitHubRateLimitError,
  GitHubRequestError,
  InvalidPullRequestRefError,
  PullRequestNotFoundError,
  ReviewPermissionError,
} from '../github/errors.js'
import { ProviderError } from '../providers/types.js'
import { InvalidLessonsAnswerError, InvalidReviewReportError } from '../review/errors.js'
import { NoDefaultBranchError, NothingToReviewError } from '../app/local-review.js'
import { LocalDiffTooLargeError, LocalGitError } from '../repository/local-git.js'
import { MissingGitHubTokenError, UsageError } from './errors.js'
import { errorSummary, formatError } from './format-error.js'

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`

function format(error: unknown, debug = false) {
  return formatError(error, { debug })
}

describe('errorSummary', () => {
  it('is the message of formatError without the program name', () => {
    const error = new ReviewPermissionError('acme/shop#12')

    expect(errorSummary(error)).toBe(error.message)
    expect(formatError(error, { debug: false }).message).toBe(`phada: ${error.message}`)
  })
})

describe('formatError', () => {
  it.each([
    [
      new LocalGitError('not-a-repository', '/w is not inside a git repository'),
      'phada: /w is not inside a git repository. Run phada in a clone of the repository, or pass a pull request (owner/repo#N).',
      2,
    ],
    [
      new LocalGitError('unknown-base', 'The base nope is not a commit in this repository.'),
      'phada: The base nope is not a commit in this repository. Pass a branch, tag or commit SHA to --base.',
      2,
    ],
    [
      new LocalGitError(
        'no-origin',
        "The repository at /w has no origin remote: error: No such remote 'origin'",
      ),
      "phada: The repository at /w has no origin remote: error: No such remote 'origin'. A local review takes its GitHub repository from origin: git remote add origin <URL of the repository on GitHub>.",
      1,
    ],
    [
      new LocalGitError(
        'origin-not-github',
        'The origin remote (https://gitlab.com/a/b.git) is not a GitHub repository.',
      ),
      'phada: The origin remote (https://gitlab.com/a/b.git) is not a GitHub repository. Phada reviews repositories on GitHub.',
      1,
    ],
    [
      new LocalGitError(
        'no-default-base',
        'origin/main is not in this repository; run git fetch origin, or pass --base.',
      ),
      'phada: origin/main is not in this repository; run git fetch origin, or pass --base.',
      1,
    ],
    [
      new LocalGitError('no-merge-base', 'abc and origin/main have no commit in common.'),
      'phada: abc and origin/main have no commit in common. Pass the commit to compare with in --base.',
      1,
    ],
    [
      new LocalGitError('no-commits', 'The repository at /w has no commits yet.'),
      'phada: The repository at /w has no commits yet.',
      1,
    ],
    [
      new LocalDiffTooLargeError('0f1e2d3..a1b2c3d', 1_000_000, 1_200_000),
      'phada: The diff of 0f1e2d3..a1b2c3d has 1200000 bytes, above the limit of 1000000 bytes. Phada never truncates a diff: pass a closer --base.',
      1,
    ],
    [
      new NoDefaultBranchError('acme/shop'),
      'phada: acme/shop has no default branch on GitHub; pass --base.',
      1,
    ],
    [
      new NothingToReviewError('feat/spend', '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c'),
      'phada: Nothing to review: feat/spend has no changes against 0f1e2d3.',
      1,
    ],
  ])('explains the local review error %#', (error, message, exitCode) => {
    expect(format(error)).toEqual({ message, exitCode })
  })

  it.each([
    [
      new UsageError('Missing the pull request to review.'),
      'phada: Missing the pull request to review. Run with --help for usage.',
      2,
    ],
    [
      new ConfigError('Invalid config /home/u/.config/phada/config.yml: colour: Unrecognized key'),
      'phada: Invalid config /home/u/.config/phada/config.yml: colour: Unrecognized key',
      2,
    ],
    [
      new SkillError('Skill "nope" is not installed. Phada looked in /home/u/.claude/skills.'),
      'phada: Skill "nope" is not installed. Phada looked in /home/u/.claude/skills.',
      2,
    ],
    [
      new InvalidPullRequestRefError('acme/shop'),
      'phada: Invalid pull request reference "acme/shop". Expected "owner/repo#123" or "https://github.com/owner/repo/pull/123".',
      2,
    ],
    [
      new MissingGitHubTokenError(),
      'phada: No GitHub token found. Log in with gh auth login, or set GITHUB_TOKEN (or GH_TOKEN) to a token that can read the pull request and write reviews (read-only is enough with --dry-run).',
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
    [new LessonNotFoundError(7), 'phada: No lesson 7 in the history.', 1],
    [new LessonDecidedError(7, 'accepted'), 'phada: Lesson 7 is already accepted.', 1],
    [
      new InvalidLessonEditError(7, 'rule: Too small'),
      'phada: The edited lesson is not valid (rule: Too small); nothing written, lesson 7 is still pending.',
      1,
    ],
    [
      new EditorNotFoundError('nano'),
      'phada: The editor "nano" was not found; set $VISUAL or $EDITOR to the one you use.',
      1,
    ],
    [
      new LessonRuleRefusedError('/c/repos/a/b/config.yml already has a rule lesson-7.'),
      'phada: /c/repos/a/b/config.yml already has a rule lesson-7.',
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
      new ProviderError('ollama', 'not-installed', 'Ollama was not found.'),
      'phada: Ollama is not installed: https://ollama.com/download',
      1,
    ],
    [
      new ProviderError('ollama', 'not-authenticated', 'Ollama refused the request for "m:cloud".'),
      'phada: Ollama is not logged in. Run "ollama signin" to use :cloud models.',
      1,
    ],
    [
      new ProviderError(
        'ollama',
        'prompt-too-large',
        'The review needs about 40000 tokens but qwen2.5-coder:7b holds 32768. Use a model with a larger context window (see "ollama show qwen2.5-coder:7b") or a :cloud model.',
      ),
      'phada: The review needs about 40000 tokens but qwen2.5-coder:7b holds 32768. Use a model with a larger context window (see "ollama show qwen2.5-coder:7b") or a :cloud model. Phada never truncates a diff.',
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

  it('explains an answer that is not a review and points to --debug', () => {
    const error = new InvalidReviewReportError('no JSON object in the answer', 'Sure! Looks good.')

    expect(format(error)).toEqual({
      message:
        'phada: The AI did not return a valid review (no JSON object in the answer). Run with --debug to see its answer.',
      exitCode: 1,
    })
  })

  it('explains an answer that holds no lessons, with the answer in debug mode', () => {
    const error = new InvalidLessonsAnswerError('no lessons list in the answer', 'Nothing here.')

    expect(format(error).message).toBe(
      'phada: The AI did not return valid lessons (no lessons list in the answer). Run with --debug to see its answer.',
    )
    expect(format(error, true).message).toContain('\nAI answer (start):\nNothing here.')
  })

  it('shows the start of the AI answer in debug mode, without control characters', () => {
    const error = new InvalidReviewReportError(
      'no JSON object in the answer',
      'Sure!\u001B[2J Looks good.',
    )

    const debug = format(error, true).message

    expect(debug).toContain('\nAI answer (start):\nSure![2J Looks good.')
    expect(format(error).message).not.toContain('Sure!')
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
