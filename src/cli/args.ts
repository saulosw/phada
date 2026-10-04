import { parseArgs } from 'node:util'
import { parsePullRequestRef } from '../github/pull-request-ref.js'
import type { PullRequestRef } from '../github/pull-request-ref.js'
import { UsageError } from './errors.js'

export type CliCommand =
  | { kind: 'help' }
  | {
      kind: 'review'
      ref: PullRequestRef
      provider: string
      model?: string
      language?: string
      debug: boolean
    }

export const USAGE = `Usage: npm run review -- <owner/repo#N | pull request URL> [options]

Reviews a GitHub pull request with the AI CLI you are logged into and prints the review.

Options:
  --provider <name>   AI provider: claude (default: claude)
  --model <name>      Model (default: your Claude default model, then opus)
  --language <tag>    Review language, e.g. pt-BR (default: English)
  --debug             Show error details
  -h, --help          Show this help

Environment:
  GITHUB_TOKEN        GitHub token with read access, e.g. export GITHUB_TOKEN=$(gh auth token)`

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const { values, positionals } = parseKnownArgs(argv)
  if (values.help) return { kind: 'help' }

  const [input, ...extra] = positionals
  if (input === undefined) throw new UsageError('Missing the pull request to review.')
  if (extra.length > 0) throw new UsageError('Review one pull request at a time.')
  if (values.model?.trim() === '') throw new UsageError('--model needs a model name.')
  if (values.language !== undefined && !LANGUAGE_TAG.test(values.language)) {
    throw new UsageError(`Invalid --language "${values.language}". Use a tag like en or pt-BR.`)
  }

  return {
    kind: 'review',
    ref: parsePullRequestRef(input),
    provider: values.provider,
    ...(values.model === undefined ? {} : { model: values.model.trim() }),
    ...(values.language === undefined ? {} : { language: values.language }),
    debug: values.debug,
  }
}

function parseKnownArgs(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        provider: { type: 'string', default: 'claude' },
        model: { type: 'string' },
        language: { type: 'string' },
        debug: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    })
  } catch (error) {
    const message = error instanceof Error ? firstSentence(error.message) : String(error)
    throw new UsageError(`${message}.`, { cause: error })
  }
}

function firstSentence(message: string): string {
  return message.split('. ')[0]?.replace(/\.$/, '') ?? message
}
