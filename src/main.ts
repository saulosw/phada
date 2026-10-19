import { reviewAndPublish } from './app/review-and-publish.js'
import type {
  PublicationResult,
  RenderedReview,
  ReviewAndPublishDeps,
  ReviewRun,
} from './app/review-and-publish.js'
import { errorMessage } from './app/error-message.js'
import { historyRun } from './cli/history-run.js'
import type { RunMeta } from './cli/history-run.js'
import { dataFiles } from './config/data-paths.js'
import type { ConfigLayer } from './config/types.js'
import { historyEnabled } from './config/watch-settings.js'
import type { SkipReason } from './publish/types.js'
import type { HistoryStore } from './store/history-store.js'
import type { PullRequestReview, PullRequestReviewDeps } from './app/review-pull-request.js'
import { parseCliArgs } from './cli/args.js'
import type { CliCommand } from './cli/args.js'
import { MissingGitHubTokenError, UsageError } from './cli/errors.js'
import { errorSummary, formatError } from './cli/format-error.js'
import {
  formatGitHubPreview,
  formatGitHubReview,
  formatIgnoredOnlyReview,
} from './cli/format-github.js'
import { formatContextLine, formatContextSection } from './cli/format-context.js'
import { formatImpactLine, formatImpactSection } from './cli/format-impact.js'
import { formatInvestigationLine, formatInvestigationSection } from './cli/format-investigation.js'
import { formatRelatedLine, formatRelatedSection } from './cli/format-related.js'
import { formatAlreadyReviewedJson, formatReviewJson } from './cli/format-json.js'
import type { Publication } from './cli/format-json.js'
import { formatPublishedMessage, formatSkipMessage } from './cli/format-publication.js'
import { formatPullRequestSummary, formatReview } from './cli/format-review.js'
import { messagesFor } from './cli/i18n/messages.js'
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
import { loadUserLayers } from './config/user-config.js'
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
import type { ReviewPass } from './investigation/tools/tool-log.js'
import { ClaudeCliProvider } from './providers/claude.js'
import { CodexCliProvider } from './providers/codex.js'
import { OllamaProvider } from './providers/ollama.js'
import type { ReviewProvider } from './providers/types.js'
import type { ReviewOutcome } from './review/types.js'

type PublishTarget = PullRequestRef & { token: string }

export interface ProviderOptions {
  model?: string
  userMcpServers?: string[]
  detached?: boolean
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
  openHistoryStore: (path: string) => Promise<HistoryStore>
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
    const startedAt = new Date().toISOString()
    const reviewRun = await reviewAndPublish(
      {
        ref: command.ref,
        mode: 'manual',
        force: command.force,
        dryRun: command.dryRun,
        publish: true,
        options: {
          language: command.language,
          minConfidence: command.minConfidence,
          verify: command.verify,
          investigate: command.investigate,
        },
        userLayers,
        userMcpServers: mcp,
      },
      reviewAndPublishDeps(deps, token, choice, command),
    )
    await saveRun(deps, userLayers, reviewRun, {
      source: 'manual',
      startedAt,
      finishedAt: new Date().toISOString(),
      provider: choice.provider,
      ...(choice.model === undefined ? {} : { model: choice.model }),
    })
    printRun(deps, command, reviewRun)
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

type ReviewCommand = Extract<CliCommand, { kind: 'review' }>
type Choice = { provider: string; model?: string }

function reviewAndPublishDeps(
  deps: MainDeps,
  token: string,
  choice: Choice,
  command: ReviewCommand,
): ReviewAndPublishDeps {
  const target = { ...command.ref, token }
  return {
    fetchPullRequest: (ref) => deps.fetchPullRequest({ ...ref, token }),
    fetchReviewState: (ref) => deps.fetchReviewState({ ...ref, token }),
    reviewDeps: (pullRequest) => pullRequestReviewDeps(deps, target, choice, pullRequest),
    render: {
      review: (result, plan, language) =>
        formatGitHubReview(result, plan, undefined, messagesFor(language)),
      ignoredOnly: (headSha, ignored, language) =>
        formatIgnoredOnlyReview(headSha, ignored, messagesFor(language)),
    },
    createReview: (pullRequest, rendered) =>
      deps.createReview({
        ...target,
        commitSha: pullRequest.headSha,
        body: rendered.body,
        comments: rendered.comments,
      }),
    events: {
      fetched: (pullRequest) => deps.stderr.write(`${formatPullRequestSummary(pullRequest)}\n`),
      reviewed: (reviewed, pullRequest) => printReviewed(deps, command, reviewed, pullRequest),
      publishing: () => deps.stderr.write('Publishing the review…\n'),
    },
  }
}

export function pullRequestReviewDeps(
  deps: MainDeps,
  repository: PublishTarget,
  choice: Choice & { detached?: boolean },
  pullRequest: PullRequest,
): PullRequestReviewDeps {
  const { owner, repo, token } = repository
  const cache = repositoryCache(deps.env, deps.home, owner, repo)
  const progress = indexProgress(deps.stderr)
  const warn = (message: string) => deps.stderr.write(`Warning: ${toTerminalText(message)}\n`)
  return {
    contextSources: contextSourcesAt(deps, repository, pullRequest.baseSha),
    openMirror: () => deps.openMirror({ dir: cache.mirror, owner, repo, token, env: deps.env }),
    openIndexStore: () => deps.openIndexStore(cache.index, deps.version),
    openObservedStore: () => deps.openObservedStore(cache.observed),
    extractor: deps.createExtractor(),
    now: () => performance.now(),
    createProvider: (servers) =>
      deps.createProvider(choice.provider, {
        ...(choice.model === undefined ? {} : { model: choice.model }),
        ...(choice.detached === true ? { detached: true } : {}),
        ...(servers.length === 0 ? {} : { userMcpServers: [...servers] }),
      }),
    watchProvider: (provider, pass) => withProgress(provider, deps.stderr, PROGRESS_LABELS[pass]),
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
          openMirror: () => deps.openMirror({ dir: paths.mirror, ...target, token, env: deps.env }),
          openIndexStore: () => deps.openIndexStore(paths.index, deps.version),
        }
      },
      extractor: deps.createExtractor(),
      now: () => performance.now(),
      events: { warning: warn, indexing: progress.extracting, indexed: progress.extracted },
    },
    events: {
      contextLoaded: (report) => {
        for (const warning of report.warnings) warn(warning)
        deps.stderr.write(`${formatContextLine(report)}\n`)
      },
      warning: warn,
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
  }
}

function printReviewed(
  deps: MainDeps,
  command: ReviewCommand,
  reviewed: PullRequestReview,
  pullRequest: PullRequest,
): void {
  const { outcome } = reviewed
  if (outcome.status === 'skipped') {
    deps.stderr.write(
      outcome.reason === 'all-ignored'
        ? 'Nothing to review: every changed file is ignored.\n'
        : 'Nothing to review: the pull request has no changes.\n',
    )
    return
  }
  for (const warning of outcome.result.warnings ?? []) {
    deps.stderr.write(`Warning: ${toTerminalText(warning)}\n`)
  }
  const investigationLine = formatInvestigationLine(reviewed.investigation)
  if (investigationLine !== undefined) deps.stderr.write(`${investigationLine}\n`)
  if (!command.dryRun && command.format === 'markdown') {
    deps.stdout.write(formatReview(pullRequest, outcome.result, messagesFor(reviewed.language)))
  }
}

export function reviewRunJson(run: ReviewRun): string {
  const { pullRequest } = run
  if (run.status === 'skipped') return formatAlreadyReviewedJson(pullRequest, run.reason)
  const { reviewed } = run
  const context = reviewed.context.report
  if (run.status === 'nothing') {
    const note = run.rendered
    const publication =
      run.publication === undefined || note === undefined
        ? null
        : toPublication(run.publication, note, { comments: 0, stillOpen: 0, dismissed: 0 })
    return formatReviewJson(pullRequest, reviewed.outcome, publication, context)
  }
  const { plan, rendered } = run
  const { investigation, impact, related } = reviewed
  return formatReviewJson(
    pullRequest,
    reviewed.outcome,
    toPublication(
      run.publication,
      rendered,
      {
        comments: rendered.comments.length,
        stillOpen: plan.stillOpen.length,
        dismissed: plan.dismissed.length,
      },
      run.wouldSkip,
    ),
    context,
    investigation,
    impact,
    related,
  )
}

interface PublicationCounts {
  comments: number
  stillOpen: number
  dismissed: number
}

function toPublication(
  publication: PublicationResult,
  rendered: RenderedReview,
  counts: PublicationCounts,
  wouldSkip?: SkipReason,
): Publication {
  switch (publication.status) {
    case 'published':
      return { status: 'published', url: publication.url, ...counts }
    case 'dry-run':
      return {
        status: 'dry-run',
        review: rendered,
        stillOpen: counts.stillOpen,
        dismissed: counts.dismissed,
        ...(wouldSkip === undefined ? {} : { wouldSkip }),
      }
    case 'failed':
      return { status: 'failed', error: errorSummary(publication.error) }
    default:
      return publication
  }
}

function printRun(deps: MainDeps, command: ReviewCommand, run: ReviewRun): void {
  const json = command.format === 'json'
  if (json) deps.stdout.write(reviewRunJson(run))
  const { pullRequest } = run
  if (run.status === 'skipped') {
    deps.stderr.write(`${formatSkipMessage(pullRequest.headSha, run.reason)}\n`)
    return
  }
  const { publication, rendered } = run
  if (publication === undefined || rendered === undefined) return
  const { reviewed } = run
  const messages = messagesFor(reviewed.language)
  const counts =
    run.status === 'reviewed'
      ? {
          comments: rendered.comments.length,
          stillOpen: run.plan.stillOpen.length,
          dismissed: run.plan.dismissed.length,
        }
      : { comments: 0, stillOpen: 0, dismissed: 0 }
  switch (publication.status) {
    case 'dry-run':
      if (!json) {
        deps.stdout.write(
          run.status === 'nothing'
            ? formatGitHubPreview(rendered, messages)
            : `${formatGitHubPreview(rendered, messages)}\n${formatContextSection(reviewed.context.report)}\n${formatImpactSection(reviewed.impact, reviewed.impactText)}\n${reviewed.related.status === 'none' ? '' : `${formatRelatedSection(reviewed.related)}\n`}${formatInvestigationSection(reviewed.investigation)}`,
        )
      }
      deps.stderr.write('Dry run: nothing was posted.\n')
      if (run.status === 'reviewed' && run.wouldSkip !== undefined) {
        deps.stderr.write(
          `Without --dry-run: ${formatSkipMessage(pullRequest.headSha, run.wouldSkip)}\n`,
        )
      }
      return
    case 'failed':
      throw publication.error
    case 'published':
      deps.stderr.write(
        `${formatPublishedMessage(publication.url, counts.comments, counts.stillOpen, counts.dismissed)}\n`,
      )
      return
    default:
      return
  }
}

async function saveRun(
  deps: MainDeps,
  userLayers: readonly ConfigLayer[],
  run: ReviewRun,
  meta: RunMeta,
): Promise<void> {
  if (!historyEnabled(userLayers)) return
  try {
    const history = await deps.openHistoryStore(dataFiles(deps.env, deps.home).history)
    try {
      history.addRun(historyRun(run, reviewRunJson(run), meta))
    } finally {
      history.close()
    }
  } catch (error) {
    deps.stderr.write(
      `Warning: ${toTerminalText(errorMessage(error))}. This review is not saved in the history.\n`,
    )
  }
}
