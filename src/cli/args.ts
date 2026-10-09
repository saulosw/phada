import { parseArgs } from 'node:util'
import type { ParseArgsOptionsConfig } from 'node:util'
import { InvalidPullRequestRefError } from '../github/errors.js'
import { parsePullRequestRef } from '../github/pull-request-ref.js'
import type { PullRequestRef } from '../github/pull-request-ref.js'
import { DEFAULT_MIN_CONFIDENCE } from '../review/run-review.js'
import { CONFIDENCE_FLOOR, isConfidenceCut, MAX_CONFIDENCE } from '../review/select-findings.js'
import { LANGUAGE_TAG } from '../config/schema.js'
import { UsageError } from './errors.js'

export type OutputFormat = 'markdown' | 'json'

export interface RepositoryName {
  owner: string
  repo: string
}

export type CliCommand =
  | { kind: 'help'; text: string }
  | { kind: 'version' }
  | { kind: 'init'; global: boolean; repo?: RepositoryName }
  | {
      kind: 'review'
      ref: PullRequestRef
      provider?: string
      model?: string
      language?: string
      minConfidence?: number
      format: OutputFormat
      verify?: boolean
      dryRun: boolean
      force: boolean
      debug: boolean
    }

export const USAGE = `Usage: phada <command> [options]

Reviews GitHub pull requests with the AI provider you choose.

Commands:
  review <pull request>  Review a pull request and publish the review on it
  init                   Create config files for Phada

Options:
  -h, --help             Show this help
  -v, --version          Show the version

Run "phada review --help" or "phada init --help" for their options.`

export const REVIEW_USAGE = `Usage: phada review <owner/repo#N | pull request URL> [options]

Reviews a GitHub pull request with the AI provider you choose and publishes the
review on it as the owner of the GitHub token: one review with a comment on the
line of each finding. Use --dry-run to only print it.

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
  --no-verify           Do not check the findings, even if your config asks to
  --dry-run             Print what would be published and post nothing
  --force               Review again even if Phada already reviewed this commit
  --debug               Show error details
  -h, --help            Show this help

Config:
  Options can also come from .phada/config.yml in the repository and from your
  own config (see "phada init --help"); flags win.

Environment:
  GITHUB_TOKEN          GitHub token that can read the pull request and the
                        repository contents and write reviews, e.g.
                        export GITHUB_TOKEN=$(gh auth token)
  GH_TOKEN              Used when GITHUB_TOKEN is not set
  OLLAMA_HOST           Ollama address (default: 127.0.0.1:11434)
  PHADA_CONFIG_HOME     Folder of your own config (default: ~/.config/phada)`

export const INIT_USAGE = `Usage: phada init [--global [<owner/repo>]]

Creates commented config files for Phada and never overwrites existing ones.

  phada init                      .phada/config.yml and .phada/rules.md in this
                                  repository, shared with everyone who clones it
  phada init --global             your own config, for every repository
  phada init --global owner/repo  your own config for one repository, kept on
                                  this machine

Options:
  --global    Create your own config instead of the repository's
  -h, --help  Show this help`

const REPOSITORY_NAME = /^([\w.-]+)\/([\w.-]+)$/

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const [command, ...rest] = argv
  if (command === 'review') return parseReviewArgs(rest)
  if (command === 'init') return parseInitArgs(rest)
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
  return new UsageError(`Unknown command "${command}". Available: review, init.`)
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

  if (values.verify === true && values['no-verify'] === true) {
    throw new UsageError('Use either --verify or --no-verify.')
  }
  const verify = values.verify === true ? true : values['no-verify'] === true ? false : undefined

  return {
    kind: 'review',
    ref: parsePullRequestRef(input),
    ...(values.provider === undefined ? {} : { provider: values.provider }),
    ...(values.model === undefined ? {} : { model: values.model.trim() }),
    ...(values.language === undefined ? {} : { language: values.language }),
    ...(minConfidence === undefined ? {} : { minConfidence }),
    format: values.format,
    ...(verify === undefined ? {} : { verify }),
    dryRun: values['dry-run'],
    force: values.force,
    debug: values.debug,
  }
}

const REVIEW_OPTIONS = {
  provider: { type: 'string' },
  model: { type: 'string' },
  language: { type: 'string' },
  'min-confidence': { type: 'string' },
  format: { type: 'string', default: 'markdown' },
  verify: { type: 'boolean' },
  'no-verify': { type: 'boolean' },
  'dry-run': { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  debug: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const satisfies ParseArgsOptionsConfig

function parseInitArgs(argv: readonly string[]): CliCommand {
  const { values, positionals } = parseOptions(argv, {
    global: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  })
  if (values.help) return { kind: 'help', text: INIT_USAGE }
  const [name, ...extra] = positionals
  if (name === undefined) return { kind: 'init', global: values.global }
  if (!values.global) {
    throw new UsageError(
      `A repository is only used with --global, e.g. phada init --global ${name}.`,
    )
  }
  if (extra.length > 0) throw new UsageError('Give one repository at a time.')
  const match = REPOSITORY_NAME.exec(name)
  if (match === null) throw new UsageError(`Invalid repository "${name}". Use owner/repo.`)
  return { kind: 'init', global: true, repo: { owner: match[1] ?? '', repo: match[2] ?? '' } }
}

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
