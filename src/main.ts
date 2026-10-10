import { parseCliArgs } from './cli/args.js'
import type { OutputFormat } from './cli/args.js'
import { MissingGitHubTokenError, UsageError } from './cli/errors.js'
import { errorSummary, formatError } from './cli/format-error.js'
import {
  formatGitHubPreview,
  formatGitHubReview,
  formatIgnoredOnlyReview,
} from './cli/format-github.js'
import type { GitHubReview } from './cli/format-github.js'
import { formatContextLine, formatContextSection } from './cli/format-context.js'
import { formatInvestigationLine, formatInvestigationSection } from './cli/format-investigation.js'
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
import { resolveProvider, userMcpServers } from './config/merge-config.js'
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
import type { Checkout } from './investigation/checkout.js'
import { CheckoutUnavailableError } from './investigation/git-checkout.js'
import type { OpenGitCheckoutOptions } from './investigation/git-checkout.js'
import { openInvestigation } from './investigation/open-investigation.js'
import type { Investigation } from './investigation/open-investigation.js'
import { buildInvestigationReport } from './investigation/report.js'
import type { InvestigationReport } from './investigation/report.js'
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
type SkippedOutcome = Extract<ReviewOutcome, { status: 'skipped' }>
type PublishTarget = PullRequestRef & { token: string }

export interface ProviderOptions {
  model?: string
  userMcpServers?: string[]
}

const PROVIDERS = ['claude', 'codex', 'ollama'] as const

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
  openCheckout: (options: OpenGitCheckoutOptions) => Promise<Checkout>
  createProvider: (name: string, options: ProviderOptions) => ReviewProvider
}

export function assertProviderChoice(name: string, options: ProviderOptions): void {
  if (!(PROVIDERS as readonly string[]).includes(name)) {
    throw new UsageError(`Unknown provider "${name}". Available: ${PROVIDERS.join(', ')}.`)
  }
  if (name === 'ollama' && options.model === undefined) {
    throw new UsageError(
      '--provider ollama needs --model, e.g. qwen2.5-coder:7b, llama3.1:8b or gpt-oss:120b-cloud (see "ollama list").',
    )
  }
}

export function createProvider(name: string, options: ProviderOptions): ReviewProvider {
  assertProviderChoice(name, options)
  switch (name) {
    case 'claude':
      return new ClaudeCliProvider(options)
    case 'codex':
      return new CodexCliProvider(options)
    default:
      return new OllamaProvider({ model: options.model ?? '' })
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
    const mcp = userMcpServers(userLayers)
    if (mcp.length > 0 && choice.provider !== 'claude') {
      throw new UsageError('mcp in your config works only with --provider claude for now.')
    }
    assertProviderChoice(choice.provider, { model: choice.model })

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
    const messages = messagesFor(language)
    const investigate = command.investigate ?? loaded.options.investigate ?? true
    let investigation: Investigation | undefined
    let unavailable: string | undefined
    if (investigate && loaded.diff.trim() !== '') {
      try {
        investigation = await openInvestigation(
          { owner, repo, sha: pullRequest.headSha, token, env: deps.env },
          deps.openCheckout,
        )
      } catch (error) {
        if (!(error instanceof CheckoutUnavailableError)) throw error
        unavailable = error.message
        deps.stderr.write(
          `Warning: ${toTerminalText(error.message)}: reviewing without investigation.\n`,
        )
      }
    }
    const servers = investigation === undefined ? [] : mcp
    if (servers.length > 0 && !pullRequest.private) {
      deps.stderr.write(
        `Warning: ${pullRequest.repo} is public: what the AI reads from ${servers.join(', ')} may end up in the published review.\n`,
      )
    }
    let provider: ReviewProvider
    try {
      provider = deps.createProvider(choice.provider, {
        model: choice.model,
        ...(servers.length === 0 ? {} : { userMcpServers: servers }),
      })
    } catch (error) {
      await investigation?.close()
      throw error
    }

    let outcome: ReviewOutcome
    try {
      outcome = await runReview(
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
          ...(investigation === undefined ? {} : { tools: investigation.tools }),
        },
      )
    } finally {
      await investigation?.close()
    }
    if (outcome.status === 'skipped' && outcome.reason === 'all-ignored') {
      deps.stderr.write('Nothing to review: every changed file is ignored.\n')
      const note = formatIgnoredOnlyReview(pullRequest.headSha, loaded.context.ignored, messages)
      await postNote(deps, repository, command, pullRequest, outcome, note, messages, loaded.report)
      return 0
    }
    if (outcome.status === 'skipped') {
      deps.stderr.write('Nothing to review: the pull request has no changes.\n')
      if (command.format === 'json') {
        deps.stdout.write(formatReviewJson(pullRequest, outcome, null, loaded.report))
      }
      return 0
    }

    for (const warning of outcome.result.warnings ?? []) {
      deps.stderr.write(`Warning: ${toTerminalText(warning)}\n`)
    }
    const investigationReport = buildInvestigationReport({
      status: investigation !== undefined ? 'used' : investigate ? 'unavailable' : 'off',
      ...(unavailable === undefined ? {} : { reason: unavailable }),
      ...(investigation === undefined ? {} : { log: investigation.log }),
      findings: outcome.result.findings,
      external: outcome.result.externalCalls ?? [],
    })
    const investigationLine = formatInvestigationLine(investigationReport)
    if (investigationLine !== undefined) deps.stderr.write(`${investigationLine}\n`)

    const plan = planPublication(outcome.result.findings, state)
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
        investigationReport,
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
        investigationReport,
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
  investigation: InvestigationReport,
): void {
  if (format === 'json') {
    const publication: Publication = {
      status: 'dry-run',
      review,
      stillOpen: plan.stillOpen.length,
      ...(wouldSkip === undefined ? {} : { wouldSkip }),
    }
    deps.stdout.write(formatReviewJson(pullRequest, outcome, publication, context, investigation))
  } else {
    deps.stdout.write(
      `${formatGitHubPreview(review, messages)}\n${formatContextSection(context)}\n${formatInvestigationSection(investigation)}`,
    )
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
  investigation: InvestigationReport,
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
      deps.stdout.write(formatReviewJson(pullRequest, outcome, failed, context, investigation))
    }
    throw error
  }
  const comments = review.comments.length
  const stillOpen = plan.stillOpen.length
  if (format === 'json') {
    const published: Publication = { status: 'published', url: created.url, comments, stillOpen }
    deps.stdout.write(formatReviewJson(pullRequest, outcome, published, context, investigation))
  }
  deps.stderr.write(`${formatPublishedMessage(created.url, comments, stillOpen)}\n`)
}

async function postNote(
  deps: MainDeps,
  target: PublishTarget,
  options: { format: OutputFormat; dryRun: boolean },
  pullRequest: PullRequest,
  outcome: SkippedOutcome,
  note: GitHubReview,
  messages: Messages,
  context: ContextReport,
): Promise<void> {
  const json = options.format === 'json'
  if (options.dryRun) {
    const preview: Publication = { status: 'dry-run', review: note, stillOpen: 0 }
    deps.stdout.write(
      json
        ? formatReviewJson(pullRequest, outcome, preview, context)
        : formatGitHubPreview(note, messages),
    )
    deps.stderr.write('Dry run: nothing was posted.\n')
    return
  }
  deps.stderr.write('Publishing the review…\n')
  let created: CreatedReview
  try {
    created = await deps.createReview({
      ...target,
      commitSha: pullRequest.headSha,
      body: note.body,
      comments: [],
    })
  } catch (error) {
    if (json) {
      const failed: Publication = { status: 'failed', error: errorSummary(error) }
      deps.stdout.write(formatReviewJson(pullRequest, outcome, failed, context))
    }
    throw error
  }
  if (json) {
    const published: Publication = {
      status: 'published',
      url: created.url,
      comments: 0,
      stillOpen: 0,
    }
    deps.stdout.write(formatReviewJson(pullRequest, outcome, published, context))
  }
  deps.stderr.write(`${formatPublishedMessage(created.url, 0, 0)}\n`)
}
