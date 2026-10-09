import { parseCliArgs } from './cli/args.js'
import type { OutputFormat } from './cli/args.js'
import { MissingGitHubTokenError, UsageError } from './cli/errors.js'
import { errorSummary, formatError } from './cli/format-error.js'
import { formatGitHubPreview, formatGitHubReview } from './cli/format-github.js'
import type { GitHubReview } from './cli/format-github.js'
import { formatContextLine, formatContextSection } from './cli/format-context.js'
import { formatAlreadyReviewedJson, formatReviewJson } from './cli/format-json.js'
import type { Publication } from './cli/format-json.js'
import { formatPublishedMessage, formatSkipMessage } from './cli/format-publication.js'
import { formatPullRequestSummary, formatReview } from './cli/format-review.js'
import { messagesFor } from './cli/i18n/messages.js'
import type { Messages } from './cli/i18n/messages.js'
import { runInit } from './cli/init.js'
import { withProgress } from './cli/progress.js'
import { toTerminalText } from './cli/terminal-text.js'
import type { TextOutput } from './cli/progress.js'
import type { LocalFileSystem } from './config/local-files.js'
import { resolveProvider } from './config/merge-config.js'
import { expandHome, loadUserLayers } from './config/user-config.js'
import { loadContext } from './context/load-context.js'
import type { ContextReport } from './context/types.js'
import type { CreatedReview, CreateReviewOptions } from './github/create-review.js'
import type {
  FetchReviewStateOptions,
  PullRequestReviewState,
} from './github/pull-request-reviews.js'
import { formatPullRequestRef } from './github/pull-request-ref.js'
import type { PullRequestRef } from './github/pull-request-ref.js'
import type { FetchPullRequestOptions, PullRequest } from './github/pull-request.js'
import type { RepositoryFilesOptions, RepositoryTree } from './github/repository-files.js'
import { ClaudeCliProvider } from './providers/claude.js'
import { CodexCliProvider } from './providers/codex.js'
import { OllamaProvider } from './providers/ollama.js'
import type { ReviewProvider } from './providers/types.js'
import { decideRun } from './publish/decide-run.js'
import { planPublication } from './publish/plan-publication.js'
import type { PublicationPlan, SkipReason } from './publish/types.js'
import { runReview } from './review/run-review.js'
import type { ReviewOutcome } from './review/types.js'

type ReviewedOutcome = Extract<ReviewOutcome, { status: 'reviewed' }>
type PublishTarget = PullRequestRef & { token: string }

export interface ProviderOptions {
  model?: string
}

export interface MainDeps {
  env: NodeJS.ProcessEnv
  version: string
  cwd: string
  home: string
  files: LocalFileSystem
  stdout: TextOutput
  stderr: TextOutput
  fetchPullRequest: (options: FetchPullRequestOptions) => Promise<PullRequest>
  fetchReviewState: (options: FetchReviewStateOptions) => Promise<PullRequestReviewState>
  createReview: (options: CreateReviewOptions) => Promise<CreatedReview>
  fetchRepositoryTree: (
    options: RepositoryFilesOptions & { sha: string },
  ) => Promise<RepositoryTree>
  fetchRepositoryFile: (
    options: RepositoryFilesOptions & { path: string; ref: string },
  ) => Promise<string | null>
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
      deps.stdout.write(`${command.text}\n`)
      return 0
    }
    if (command.kind === 'version') {
      deps.stdout.write(`${deps.version}\n`)
      return 0
    }
    if (command.kind === 'init') {
      const lines = await runInit(command, deps)
      deps.stderr.write(`${lines.join('\n')}\n`)
      return 0
    }
    debug = command.debug

    const token = deps.env.GITHUB_TOKEN?.trim() || deps.env.GH_TOKEN?.trim()
    if (!token) throw new MissingGitHubTokenError()
    const { owner, repo } = command.ref
    const userLayers = await loadUserLayers({
      env: deps.env,
      home: deps.home,
      owner,
      repo,
      files: deps.files,
    })
    const choice = resolveProvider({ provider: command.provider, model: command.model }, userLayers)
    const provider = deps.createProvider(choice.provider, { model: choice.model })

    deps.stderr.write(`Fetching ${formatPullRequestRef(command.ref)}…\n`)
    const pullRequest = await deps.fetchPullRequest({ ...command.ref, token })
    deps.stderr.write(`${formatPullRequestSummary(pullRequest)}\n`)

    const state = await deps.fetchReviewState({ ...command.ref, token })
    const decision = decideRun(state, {
      headSha: pullRequest.headSha,
      force: command.force,
      dryRun: command.dryRun,
    })
    if (decision.action === 'skip') {
      deps.stderr.write(`${formatSkipMessage(pullRequest.headSha, decision.reason)}\n`)
      if (command.format === 'json') {
        deps.stdout.write(formatAlreadyReviewedJson(pullRequest, decision.reason))
      }
      return 0
    }

    const repository = { ...command.ref, token }
    const loaded = await loadContext({
      diff: pullRequest.diff,
      baseSha: pullRequest.baseSha,
      userLayers,
      sources: {
        readTree: () => deps.fetchRepositoryTree({ ...repository, sha: pullRequest.baseSha }),
        readRepoFile: (path) =>
          deps.fetchRepositoryFile({ ...repository, path, ref: pullRequest.baseSha }),
        readLocalFile: (path) => deps.files.readText(expandHome(path, deps.home)),
        listLocalDocs: (path) => deps.files.listDocs(expandHome(path, deps.home)),
      },
    })
    for (const warning of loaded.report.warnings) {
      deps.stderr.write(`Warning: ${toTerminalText(warning)}\n`)
    }
    deps.stderr.write(`${formatContextLine(loaded.report)}\n`)
    const language = command.language ?? loaded.options.language

    const outcome = await runReview(
      {
        pullRequest: { ...pullRequest, diff: loaded.diff },
        language,
        minConfidence: command.minConfidence ?? loaded.options.minConfidence,
        verify: command.verify ?? loaded.options.verify ?? false,
        context: loaded.context,
      },
      {
        provider: withProgress(provider, deps.stderr),
        verifier: withProgress(provider, deps.stderr, 'Verifying findings'),
      },
    )
    if (outcome.status === 'skipped') {
      deps.stderr.write(
        outcome.reason === 'all-ignored'
          ? 'Nothing to review: every changed file is ignored.\n'
          : 'Nothing to review: the pull request has no changes.\n',
      )
      if (command.format === 'json') {
        deps.stdout.write(formatReviewJson(pullRequest, outcome, null, loaded.report))
      }
      return 0
    }

    const plan = planPublication(outcome.result.findings, state)
    const messages = messagesFor(language)
    const review = formatGitHubReview(outcome.result, plan, undefined, messages)
    if (command.dryRun) {
      printDryRun(
        deps,
        command.format,
        pullRequest,
        outcome,
        review,
        plan,
        decision.wouldSkip,
        messages,
        loaded.report,
      )
    } else {
      await publish(
        deps,
        repository,
        command.format,
        pullRequest,
        outcome,
        review,
        plan,
        messages,
        loaded.report,
      )
    }
    return 0
  } catch (error) {
    const { message, exitCode } = formatError(error, { debug })
    deps.stderr.write(`${message}\n`)
    return exitCode
  }
}

function printDryRun(
  deps: MainDeps,
  format: OutputFormat,
  pullRequest: PullRequest,
  outcome: ReviewedOutcome,
  review: GitHubReview,
  plan: PublicationPlan,
  wouldSkip: SkipReason | undefined,
  messages: Messages,
  context: ContextReport,
): void {
  if (format === 'json') {
    const publication: Publication = {
      status: 'dry-run',
      review,
      stillOpen: plan.stillOpen.length,
      ...(wouldSkip === undefined ? {} : { wouldSkip }),
    }
    deps.stdout.write(formatReviewJson(pullRequest, outcome, publication, context))
  } else {
    deps.stdout.write(`${formatGitHubPreview(review, messages)}\n${formatContextSection(context)}`)
  }
  deps.stderr.write('Dry run: nothing was posted.\n')
  if (wouldSkip !== undefined) {
    deps.stderr.write(`Without --dry-run: ${formatSkipMessage(pullRequest.headSha, wouldSkip)}\n`)
  }
}

async function publish(
  deps: MainDeps,
  target: PublishTarget,
  format: OutputFormat,
  pullRequest: PullRequest,
  outcome: ReviewedOutcome,
  review: GitHubReview,
  plan: PublicationPlan,
  messages: Messages,
  context: ContextReport,
): Promise<void> {
  if (format === 'markdown') deps.stdout.write(formatReview(pullRequest, outcome.result, messages))
  deps.stderr.write('Publishing the review…\n')
  let created: CreatedReview
  try {
    created = await deps.createReview({
      ...target,
      commitSha: pullRequest.headSha,
      body: review.body,
      comments: review.comments,
    })
  } catch (error) {
    if (format === 'json') {
      const failed: Publication = { status: 'failed', error: errorSummary(error) }
      deps.stdout.write(formatReviewJson(pullRequest, outcome, failed, context))
    }
    throw error
  }
  const comments = review.comments.length
  const stillOpen = plan.stillOpen.length
  if (format === 'json') {
    const published: Publication = { status: 'published', url: created.url, comments, stillOpen }
    deps.stdout.write(formatReviewJson(pullRequest, outcome, published, context))
  }
  deps.stderr.write(`${formatPublishedMessage(created.url, comments, stillOpen)}\n`)
}
