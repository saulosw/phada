import { reviewPullRequest } from './app/review-pull-request.js'
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
import { formatImpactLine, formatImpactSection } from './cli/format-impact.js'
import { formatInvestigationLine, formatInvestigationSection } from './cli/format-investigation.js'
import { formatRelatedLine, formatRelatedSection } from './cli/format-related.js'
import type { RelatedReport } from './app/related-report.js'
import { formatAlreadyReviewedJson, formatReviewJson } from './cli/format-json.js'
import type { Publication } from './cli/format-json.js'
import { formatPublishedMessage, formatSkipMessage } from './cli/format-publication.js'
import { formatPullRequestSummary, formatReview } from './cli/format-review.js'
import { messagesFor } from './cli/i18n/messages.js'
import type { Messages } from './cli/i18n/messages.js'
import { runIndex } from './cli/index-command.js'
import { runInit } from './cli/init.js'
import { runRules } from './cli/rules-command.js'
import { contextSourcesAt } from './cli/context-sources.js'
import { indexProgress, withProgress } from './cli/progress.js'
import { toTerminalText } from './cli/terminal-text.js'
import type { TextOutput } from './cli/progress.js'
import type { LocalFileSystem } from './config/local-files.js'
import { resolveProvider, userMcpServers } from './config/merge-config.js'
import { repositoryCache } from './config/cache-paths.js'
import { expandHome, loadUserLayers } from './config/user-config.js'
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
import { RepositoryAccessError } from './github/repository.js'
import type { RepositoryInfo } from './github/repository.js'
import type { Extractor } from './repo-map/extract.js'
import type { GitMirror, GitMirrorOptions } from './repository/git-mirror.js'
import type { IndexStore } from './store/index-store.js'
import type { ObservedStore } from './store/observed-store.js'
import type { ImpactReport } from './graph/report.js'
import type { InvestigationReport } from './investigation/tools/report.js'
import type { ReviewPass } from './investigation/tools/tool-log.js'
import { ClaudeCliProvider } from './providers/claude.js'
import { CodexCliProvider } from './providers/codex.js'
import { OllamaProvider } from './providers/ollama.js'
import type { ReviewProvider } from './providers/types.js'
import { decideRun } from './publish/decide-run.js'
import { planPublication } from './publish/plan-publication.js'
import type { PublicationPlan, SkipReason } from './publish/types.js'
import type { ReviewOutcome } from './review/types.js'

type ReviewedOutcome = Extract<ReviewOutcome, { status: 'reviewed' }>
type SkippedOutcome = Extract<ReviewOutcome, { status: 'skipped' }>
type PublishTarget = PullRequestRef & { token: string }

interface ReviewReports {
  context: ContextReport
  investigation: InvestigationReport
  impact: ImpactReport
  impactText?: string
  related: RelatedReport
}

export interface ProviderOptions {
  model?: string
  userMcpServers?: string[]
}

const PROVIDERS = ['claude', 'codex', 'ollama'] as const
const PROGRESS_LABELS: Readonly<Record<ReviewPass, string>> = {
  review: 'Reviewing',
  verify: 'Verifying findings',
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
  fetchRepository: (options: RepositoryFilesOptions) => Promise<RepositoryInfo>
  openMirror: (options: GitMirrorOptions) => Promise<GitMirror>
  openIndexStore: (path: string, version: string) => Promise<IndexStore>
  openObservedStore: (path: string) => Promise<ObservedStore>
  createExtractor: () => Extractor
  pathSize: (path: string) => Promise<number>
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
    if (command.kind === 'index') {
      await runIndex(command, deps)
      return 0
    }
    if (command.kind === 'rules') {
      await runRules(command, deps)
      return 0
    }

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
    const cache = repositoryCache(deps.env, deps.home, owner, repo)
    const progress = indexProgress(deps.stderr)
    const reviewed = await reviewPullRequest(
      {
        pullRequest,
        userLayers,
        userMcpServers: mcp,
        options: {
          language: command.language,
          minConfidence: command.minConfidence,
          verify: command.verify,
          investigate: command.investigate,
        },
      },
      {
        contextSources: contextSourcesAt(deps, repository, pullRequest.baseSha),
        openMirror: () => deps.openMirror({ dir: cache.mirror, owner, repo, token, env: deps.env }),
        openIndexStore: () => deps.openIndexStore(cache.index, deps.version),
        openObservedStore: () => deps.openObservedStore(cache.observed),
        extractor: deps.createExtractor(),
        now: () => performance.now(),
        createProvider: (servers) =>
          deps.createProvider(choice.provider, {
            model: choice.model,
            ...(servers.length === 0 ? {} : { userMcpServers: [...servers] }),
          }),
        watchProvider: (provider, pass) =>
          withProgress(provider, deps.stderr, PROGRESS_LABELS[pass]),
        related: {
          readRepository: (name) =>
            deps.fetchRepository({ ...splitRepo(name), token }).catch((error: unknown) => {
              if (error instanceof RepositoryAccessError) return 'no-access' as const
              throw error
            }),
          openRelated: (name) => {
            const target = splitRepo(name)
            const paths = repositoryCache(deps.env, deps.home, target.owner, target.repo)
            return {
              openMirror: () =>
                deps.openMirror({ dir: paths.mirror, ...target, token, env: deps.env }),
              openIndexStore: () => deps.openIndexStore(paths.index, deps.version),
            }
          },
          extractor: deps.createExtractor(),
          now: () => performance.now(),
          events: {
            warning: (message) => deps.stderr.write(`Warning: ${toTerminalText(message)}\n`),
            indexing: progress.extracting,
            indexed: progress.extracted,
          },
        },
        events: {
          contextLoaded: (report) => {
            for (const warning of report.warnings) {
              deps.stderr.write(`Warning: ${toTerminalText(warning)}\n`)
            }
            deps.stderr.write(`${formatContextLine(report)}\n`)
          },
          warning: (message) => deps.stderr.write(`Warning: ${toTerminalText(message)}\n`),
          indexing: progress.extracting,
          indexed: progress.extracted,
          impactReady: (report) => {
            const line = formatImpactLine(report)
            if (line !== undefined) deps.stderr.write(`${line}\n`)
          },
          relatedReady: (report) => {
            const line = formatRelatedLine(report)
            if (line !== undefined) deps.stderr.write(`${line}\n`)
          },
        },
      },
    )
    const { outcome, context: loaded } = reviewed
    const messages = messagesFor(reviewed.language)
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
    const reports: ReviewReports = {
      context: loaded.report,
      investigation: reviewed.investigation,
      impact: reviewed.impact,
      ...(reviewed.impactText === undefined ? {} : { impactText: reviewed.impactText }),
      related: reviewed.related,
    }
    const investigationLine = formatInvestigationLine(reports.investigation)
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
        reports,
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
        reports,
      )
    }
    return 0
  } catch (error) {
    const { message, exitCode } = formatError(error, { debug })
    deps.stderr.write(`${message}\n`)
    return exitCode
  }
}

function splitRepo(name: string): { owner: string; repo: string } {
  const [owner = '', repo = ''] = name.split('/')
  return { owner, repo }
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
  reports: ReviewReports,
): void {
  const { context, investigation, impact, related } = reports
  if (format === 'json') {
    const publication: Publication = {
      status: 'dry-run',
      review,
      stillOpen: plan.stillOpen.length,
      ...(wouldSkip === undefined ? {} : { wouldSkip }),
    }
    deps.stdout.write(
      formatReviewJson(pullRequest, outcome, publication, context, investigation, impact, related),
    )
  } else {
    deps.stdout.write(
      `${formatGitHubPreview(review, messages)}\n${formatContextSection(context)}\n${formatImpactSection(impact, reports.impactText)}\n${related.status === 'none' ? '' : `${formatRelatedSection(related)}\n`}${formatInvestigationSection(investigation)}`,
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
  reports: ReviewReports,
): Promise<void> {
  const { context, investigation, impact, related } = reports
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
      deps.stdout.write(
        formatReviewJson(pullRequest, outcome, failed, context, investigation, impact, related),
      )
    }
    throw error
  }
  const comments = review.comments.length
  const stillOpen = plan.stillOpen.length
  if (format === 'json') {
    const published: Publication = { status: 'published', url: created.url, comments, stillOpen }
    deps.stdout.write(
      formatReviewJson(pullRequest, outcome, published, context, investigation, impact, related),
    )
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
