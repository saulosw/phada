import { pathToFileURL } from 'node:url'
import { parseCliArgs, USAGE } from './cli/args.js'
import { MissingGitHubTokenError, UsageError } from './cli/errors.js'
import { formatError } from './cli/format-error.js'
import { formatPullRequestSummary, formatReview } from './cli/format-review.js'
import { withProgress } from './cli/progress.js'
import type { TextOutput } from './cli/progress.js'
import { formatPullRequestRef } from './github/pull-request-ref.js'
import { fetchPullRequest } from './github/pull-request.js'
import type { FetchPullRequestOptions, PullRequest } from './github/pull-request.js'
import { ClaudeCliProvider } from './providers/claude.js'
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
    default:
      throw new UsageError(`Unknown provider "${name}". Available: claude.`)
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
      { pullRequest, language: command.language },
      { provider: withProgress(provider, deps.stderr) },
    )
    if (outcome.status === 'skipped') {
      deps.stderr.write('Nothing to review: the pull request has no changes.\n')
      return 0
    }
    deps.stdout.write(formatReview(pullRequest, outcome.result))
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
