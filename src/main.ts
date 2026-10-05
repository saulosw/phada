import { pathToFileURL } from 'node:url'
import { parseCliArgs, USAGE } from './cli/args.js'
import { MissingGitHubTokenError, UsageError } from './cli/errors.js'
import { formatError } from './cli/format-error.js'
import { formatReviewJson } from './cli/format-json.js'
import { formatPullRequestSummary, formatReview } from './cli/format-review.js'
import { withProgress } from './cli/progress.js'
import type { TextOutput } from './cli/progress.js'
import { formatPullRequestRef } from './github/pull-request-ref.js'
import { fetchPullRequest } from './github/pull-request.js'
import type { FetchPullRequestOptions, PullRequest } from './github/pull-request.js'
import { ClaudeCliProvider } from './providers/claude.js'
import { CodexCliProvider } from './providers/codex.js'
import { OllamaProvider } from './providers/ollama.js'
import type { ReviewProvider } from './providers/types.js'
import { runReview } from './review/run-review.js'

export interface ProviderOptions {
  model?: string
}

export interface MainDeps {
  env: NodeJS.ProcessEnv
  stdout: TextOutput
  stderr: TextOutput
  fetchPullRequest: (options: FetchPullRequestOptions) => Promise<PullRequest>
  createProvider: (name: string, options: ProviderOptions) => ReviewProvider
}

export function createProvider(name: string, options: ProviderOptions): ReviewProvider {
  switch (name) {
    case 'claude':
      return new ClaudeCliProvider(options)
    case 'codex':
      return new CodexCliProvider(options)
    case 'ollama':
      if (options.model === undefined) {
        throw new UsageError(
          '--provider ollama needs --model, e.g. qwen2.5-coder:7b, llama3.1:8b or gpt-oss:120b-cloud (see "ollama list").',
        )
      }
      return new OllamaProvider({ model: options.model })
    default:
      throw new UsageError(`Unknown provider "${name}". Available: claude, codex, ollama.`)
  }
}

export async function run(argv: readonly string[], deps: MainDeps): Promise<number> {
  let debug = false
  try {
    const command = parseCliArgs(argv)
    if (command.kind === 'help') {
      deps.stdout.write(`${USAGE}\n`)
      return 0
    }
    debug = command.debug

    const token = deps.env.GITHUB_TOKEN?.trim()
    if (!token) throw new MissingGitHubTokenError()
    const provider = deps.createProvider(command.provider, { model: command.model })

    deps.stderr.write(`Fetching ${formatPullRequestRef(command.ref)}…\n`)
    const pullRequest = await deps.fetchPullRequest({ ...command.ref, token })
    deps.stderr.write(`${formatPullRequestSummary(pullRequest)}\n`)

    const outcome = await runReview(
      { pullRequest, language: command.language, minConfidence: command.minConfidence },
      { provider: withProgress(provider, deps.stderr) },
    )
    if (outcome.status === 'skipped') {
      deps.stderr.write('Nothing to review: the pull request has no changes.\n')
    }
    if (command.format === 'json') {
      deps.stdout.write(formatReviewJson(pullRequest, outcome))
    } else if (outcome.status === 'reviewed') {
      deps.stdout.write(formatReview(pullRequest, outcome.result))
    }
    return 0
  } catch (error) {
    const { message, exitCode } = formatError(error, { debug })
    deps.stderr.write(`${message}\n`)
    return exitCode
  }
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await run(process.argv.slice(2), {
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    fetchPullRequest,
    createProvider,
  })
}
