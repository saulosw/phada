import { parseArgs } from 'node:util'
import type { ParseArgsOptionsConfig } from 'node:util'
import { InvalidPullRequestRefError } from '../github/errors.js'
import { parsePullRequestRef } from '../github/pull-request-ref.js'
import type { PullRequestRef } from '../github/pull-request-ref.js'
import { DEFAULT_MIN_CONFIDENCE } from '../review/run-review.js'
import { CONFIDENCE_FLOOR, isConfidenceCut, MAX_CONFIDENCE } from '../review/select-findings.js'
import { UsageError } from './errors.js'

export type OutputFormat = 'markdown' | 'json'

export type CliCommand =
  | { kind: 'help'; text: string }
  | { kind: 'version' }
  | {
      kind: 'review'
      ref: PullRequestRef
      provider: string
      model?: string
      language?: string
      minConfidence?: number
      format: OutputFormat
      verify: boolean
      debug: boolean
    }

export const USAGE = `Usage: phada <command> [options]

Reviews GitHub pull requests with the AI provider you choose.

Commands:
  review <pull request>  Review a pull request and print the review

Options:
  -h, --help             Show this help
  -v, --version          Show the version

Run "phada review --help" for the review options.`

export const REVIEW_USAGE = `Usage: phada review <owner/repo#N | pull request URL> [options]

Reviews a GitHub pull request with the AI provider you choose and prints the review.

Options:
  --provider <name>     AI provider: claude, codex or ollama (default: claude)
  --model <name>        Model (required for ollama; otherwise the model set in the
                        provider's own config; for claude, opus when none is set)
  --language <tag>      Review language, e.g. pt-BR (default: English)
  --min-confidence <n>  Confidence cut from ${CONFIDENCE_FLOOR} to ${MAX_CONFIDENCE} (default: ${DEFAULT_MIN_CONFIDENCE}); findings
                        below it are listed as worth checking
  --format <name>       Output: markdown or json (default: markdown)
  --verify              Check every finding with a second call to the AI (about
                        twice the time and tokens)
  --debug               Show error details
  -h, --help            Show this help

Environment:
  GITHUB_TOKEN          GitHub token that can read the pull request, e.g.
                        export GITHUB_TOKEN=$(gh auth token)
  GH_TOKEN              Used when GITHUB_TOKEN is not set
  OLLAMA_HOST           Ollama address (default: 127.0.0.1:11434)`

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const [command, ...rest] = argv
  if (command === 'review') return parseReviewArgs(rest)
  if (command !== undefined && !command.startsWith('-')) throw unknownCommand(command)

  const { values } = parseOptions(argv, {
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'v', default: false },
  })
  if (values.help) return { kind: 'help', text: USAGE }
  if (values.version) return { kind: 'version' }
  throw new UsageError('Missing the command, e.g. phada review owner/repo#123.')
}

function unknownCommand(command: string): UsageError {
  if (isPullRequestRef(command)) {
    return new UsageError(`Unknown command "${command}". Did you mean "phada review ${command}"?`)
  }
  return new UsageError(`Unknown command "${command}". Available: review.`)
}

function isPullRequestRef(input: string): boolean {
  try {
    parsePullRequestRef(input)
    return true
  } catch (error) {
    if (error instanceof InvalidPullRequestRefError) return false
    throw error
  }
}

function parseReviewArgs(argv: readonly string[]): CliCommand {
  const { values, positionals } = parseOptions(argv, REVIEW_OPTIONS)
  if (values.help) return { kind: 'help', text: REVIEW_USAGE }

  const [input, ...extra] = positionals
  if (input === undefined) throw new UsageError('Missing the pull request to review.')
  if (extra.length > 0) throw new UsageError('Review one pull request at a time.')
  if (values.model?.trim() === '') throw new UsageError('--model needs a model name.')
  if (values.language !== undefined && !LANGUAGE_TAG.test(values.language)) {
    throw new UsageError(`Invalid --language "${values.language}". Use a tag like en or pt-BR.`)
  }
  const minConfidence = parseMinConfidence(values['min-confidence'])
  if (!isOutputFormat(values.format)) {
    throw new UsageError(`Invalid --format "${values.format}". Use markdown or json.`)
  }

  return {
    kind: 'review',
    ref: parsePullRequestRef(input),
    provider: values.provider,
    ...(values.model === undefined ? {} : { model: values.model.trim() }),
    ...(values.language === undefined ? {} : { language: values.language }),
    ...(minConfidence === undefined ? {} : { minConfidence }),
    format: values.format,
    verify: values.verify,
    debug: values.debug,
  }
}

const REVIEW_OPTIONS = {
  provider: { type: 'string', default: 'claude' },
  model: { type: 'string' },
  language: { type: 'string' },
  'min-confidence': { type: 'string' },
  format: { type: 'string', default: 'markdown' },
  verify: { type: 'boolean', default: false },
  debug: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const satisfies ParseArgsOptionsConfig

function parseOptions<T extends ParseArgsOptionsConfig>(argv: readonly string[], options: T) {
  try {
    return parseArgs({ args: [...argv], allowPositionals: true, strict: true, options })
  } catch (error) {
    const message = error instanceof Error ? firstSentence(error.message) : String(error)
    throw new UsageError(`${message}.`, { cause: error })
  }
}

function parseMinConfidence(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const cut = /^\d+$/.test(value) ? Number(value) : Number.NaN
  if (!isConfidenceCut(cut)) {
    throw new UsageError(
      `Invalid --min-confidence "${value}". Use a whole number from ${CONFIDENCE_FLOOR} to ${MAX_CONFIDENCE}.`,
    )
  }
  return cut
}

function isOutputFormat(value: string): value is OutputFormat {
  return value === 'markdown' || value === 'json'
}

function firstSentence(message: string): string {
  return message.split('. ')[0]?.replace(/\.$/, '') ?? message
}
