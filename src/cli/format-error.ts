import { ConfigError } from '../config/errors.js'
import { DiffTooLargeError, GitHubError, InvalidPullRequestRefError } from '../github/errors.js'
import { ProviderError } from '../providers/types.js'
import { CheckoutUnavailableError } from '../repository/git-checkout.js'
import { InvalidLessonsAnswerError, InvalidReviewReportError } from '../review/errors.js'
import { SkillError } from '../skills/errors.js'
import { HistoryStoreError } from '../store/history-store.js'
import { IndexStoreError } from '../store/index-store.js'
import {
  MissingGitHubTokenError,
  PublishRefusedError,
  MissNotFoundError,
  RunNotFoundError,
  UsageError,
  WatchRunningError,
} from './errors.js'
import { HeadNotInPullRequestError, ReplayNeedsDryRunError } from '../app/replay.js'
import {
  InvalidLessonEditError,
  LessonDecidedError,
  LessonNotFoundError,
  LessonRuleRefusedError,
} from '../app/decide-lesson.js'
import { NoLocalBranchError, NoLocalReviewError } from '../app/local-fix.js'
import {
  ClosedPullRequestFixError,
  ForkFixError,
  NoPushPermissionError,
} from '../app/pull-request-fix.js'
import { NoDefaultBranchError, NothingToReviewError } from '../app/local-review.js'
import { singleLine, toTerminalText } from '../app/terminal-text.js'
import { MissingGitIdentityError } from '../repository/git-identity.js'
import { LocalDiffTooLargeError, LocalGitError } from '../repository/local-git.js'
import { BranchMovedError } from '../repository/branch-moved.js'
import { CommitFailedError, PushFailedError } from '../repository/push-fix.js'
import type { LocalGitErrorReason } from '../repository/local-git.js'
import { EditorNotFoundError } from './text-editor.js'

export interface FormattedError {
  message: string
  exitCode: 1 | 2
}

interface ProviderHints {
  name: string
  install: string
  login: string
}

const LOCAL_GIT_HINTS: Readonly<Partial<Record<LocalGitErrorReason, string>>> = {
  'not-a-repository':
    'Run phada in a clone of the repository, or pass a pull request (owner/repo#N).',
  'unknown-base': 'Pass a branch, tag or commit SHA to --base.',
  'no-origin':
    'A local review takes its GitHub repository from origin: git remote add origin <URL of the repository on GitHub>.',
  'origin-not-github': 'Phada reviews repositories on GitHub.',
  'no-merge-base': 'Pass the commit to compare with in --base.',
}

const PROVIDER_HINTS: Readonly<Record<string, ProviderHints>> = {
  'claude-cli': {
    name: 'Claude Code',
    install: 'https://code.claude.com',
    login: 'Run "claude" and then /login.',
  },
  'codex-cli': {
    name: 'Codex CLI',
    install: 'npm i -g @openai/codex',
    login: 'Run "codex login".',
  },
  ollama: {
    name: 'Ollama',
    install: 'https://ollama.com/download',
    login: 'Run "ollama signin" to use :cloud models.',
  },
}

export function formatError(error: unknown, options: { debug: boolean }): FormattedError {
  const line = `phada: ${errorSummary(error)}`
  const { exitCode } = describe(error)
  return { message: options.debug ? `${line}\n${details(error)}` : line, exitCode }
}

export function errorSummary(error: unknown): string {
  return singleLine(describe(error).summary)
}

function describe(error: unknown): { summary: string; exitCode: 1 | 2 } {
  if (error instanceof UsageError) {
    return { summary: `${error.message} Run with --help for usage.`, exitCode: 2 }
  }
  if (error instanceof ConfigError) return { summary: error.message, exitCode: 2 }
  if (error instanceof SkillError) return { summary: error.message, exitCode: 2 }
  if (error instanceof InvalidPullRequestRefError) return { summary: error.message, exitCode: 2 }
  if (error instanceof ReplayNeedsDryRunError) return { summary: error.message, exitCode: 2 }
  if (error instanceof HeadNotInPullRequestError) return { summary: error.message, exitCode: 1 }
  if (error instanceof MissingGitHubTokenError) return { summary: error.message, exitCode: 1 }
  if (
    error instanceof WatchRunningError ||
    error instanceof HistoryStoreError ||
    error instanceof RunNotFoundError ||
    error instanceof MissNotFoundError ||
    error instanceof LessonNotFoundError ||
    error instanceof LessonDecidedError ||
    error instanceof LessonRuleRefusedError ||
    error instanceof InvalidLessonEditError ||
    error instanceof EditorNotFoundError ||
    error instanceof PublishRefusedError
  ) {
    return { summary: error.message, exitCode: 1 }
  }
  if (error instanceof LocalGitError) return describeLocalGitError(error)
  if (error instanceof LocalDiffTooLargeError) {
    return {
      summary: `${error.message} Phada never truncates a diff: pass a closer --base.`,
      exitCode: 1,
    }
  }
  if (
    error instanceof NoDefaultBranchError ||
    error instanceof NothingToReviewError ||
    error instanceof NoLocalReviewError ||
    error instanceof NoLocalBranchError ||
    error instanceof ForkFixError ||
    error instanceof ClosedPullRequestFixError ||
    error instanceof NoPushPermissionError ||
    error instanceof MissingGitIdentityError ||
    error instanceof BranchMovedError ||
    error instanceof CommitFailedError ||
    error instanceof PushFailedError
  ) {
    return { summary: error.message, exitCode: 1 }
  }
  if (error instanceof DiffTooLargeError) {
    return { summary: `${error.message} Phada never truncates a diff.`, exitCode: 1 }
  }
  if (error instanceof GitHubError) return { summary: error.message, exitCode: 1 }
  if (error instanceof CheckoutUnavailableError || error instanceof IndexStoreError) {
    return { summary: error.message, exitCode: 1 }
  }
  if (error instanceof ProviderError) return { summary: describeProviderError(error), exitCode: 1 }
  if (error instanceof InvalidReviewReportError || error instanceof InvalidLessonsAnswerError) {
    return { summary: `${error.message} Run with --debug to see its answer.`, exitCode: 1 }
  }
  const message = error instanceof Error ? error.message : String(error)
  return {
    summary: `Unexpected error: ${message.replace(/\.$/, '')}. Run with --debug for details.`,
    exitCode: 1,
  }
}

function describeLocalGitError(error: LocalGitError): { summary: string; exitCode: 1 | 2 } {
  const hint = LOCAL_GIT_HINTS[error.reason]
  const usage = error.reason === 'not-a-repository' || error.reason === 'unknown-base'
  return {
    summary: hint === undefined ? error.message : `${sentence(error.message)} ${hint}`,
    exitCode: usage ? 2 : 1,
  }
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

function describeProviderError(error: ProviderError): string {
  if (error.reason === 'prompt-too-large') return `${error.message} Phada never truncates a diff.`
  const hints = PROVIDER_HINTS[error.providerId]
  if (hints === undefined) return error.message
  if (error.reason === 'not-installed') return `${hints.name} is not installed: ${hints.install}`
  if (error.reason === 'not-authenticated') return `${hints.name} is not logged in. ${hints.login}`
  return error.message
}

function details(error: unknown): string {
  const lines: string[] = []
  let current: unknown = error
  while (current !== undefined) {
    const text = current instanceof Error ? (current.stack ?? current.message) : String(current)
    lines.push(lines.length === 0 ? text : `Caused by: ${text}`)
    current = current instanceof Error ? current.cause : undefined
  }
  if (error instanceof InvalidReviewReportError || error instanceof InvalidLessonsAnswerError)
    lines.push(`AI answer (start):\n${error.preview}`)
  return toTerminalText(lines.join('\n'))
}
