import { DiffTooLargeError, GitHubError, InvalidPullRequestRefError } from '../github/errors.js'
import { ProviderError } from '../providers/types.js'
import { InvalidReviewReportError } from '../review/errors.js'
import { MissingGitHubTokenError, UsageError } from './errors.js'
import { toTerminalText } from './terminal-text.js'

export interface FormattedError {
  message: string
  exitCode: 1 | 2
}

interface ProviderHints {
  name: string
  install: string
  login: string
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
  const { summary, exitCode } = describe(error)
  const line = `phada: ${singleLine(summary)}`
  return { message: options.debug ? `${line}\n${details(error)}` : line, exitCode }
}

function describe(error: unknown): { summary: string; exitCode: 1 | 2 } {
  if (error instanceof UsageError) {
    return { summary: `${error.message} Run with --help for usage.`, exitCode: 2 }
  }
  if (error instanceof InvalidPullRequestRefError) return { summary: error.message, exitCode: 2 }
  if (error instanceof MissingGitHubTokenError) return { summary: error.message, exitCode: 1 }
  if (error instanceof DiffTooLargeError) {
    return { summary: `${error.message} Phada never truncates a diff.`, exitCode: 1 }
  }
  if (error instanceof GitHubError) return { summary: error.message, exitCode: 1 }
  if (error instanceof ProviderError) return { summary: describeProviderError(error), exitCode: 1 }
  if (error instanceof InvalidReviewReportError) {
    return { summary: `${error.message} Run with --debug to see its answer.`, exitCode: 1 }
  }
  const message = error instanceof Error ? error.message : String(error)
  return {
    summary: `Unexpected error: ${message.replace(/\.$/, '')}. Run with --debug for details.`,
    exitCode: 1,
  }
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
  if (error instanceof InvalidReviewReportError) lines.push(`AI answer (start):\n${error.preview}`)
  return toTerminalText(lines.join('\n'))
}

function singleLine(text: string): string {
  return toTerminalText(text)
    .replace(/\s*\n\s*/g, ' ')
    .trim()
}
