import { reviewAndPublish } from './app/review-and-publish.js'
import type { ReviewAndPublishDeps, ReviewRun } from './app/review-and-publish.js'
import { errorMessage } from './app/error-message.js'
import { historyRun } from './cli/history-run.js'
import type { RunMeta } from './cli/history-run.js'
import { dataFiles } from './config/data-paths.js'
import type { ConfigLayer } from './config/types.js'
import { historyEnabled } from './config/watch-settings.js'
import type { HistoryStore } from './store/history-store.js'
import type { PullRequestReview } from './app/review-pull-request.js'
import { parseCliArgs } from './cli/args.js'
import type { CliCommand } from './cli/args.js'
import { MissingGitHubTokenError, UsageError } from './cli/errors.js'
import { formatError } from './cli/format-error.js'
import { formatGitHubPreview } from './cli/format-github.js'
import { formatContextSection } from './cli/format-context.js'
import { formatImpactSection } from './cli/format-impact.js'
import { formatInvestigationLine, formatInvestigationSection } from './cli/format-investigation.js'
import { formatRelatedSection } from './cli/format-related.js'
import { formatPublishedMessage, formatSkipMessage } from './cli/format-publication.js'
import { formatPullRequestSummary, formatReview } from './cli/format-review.js'
import { messagesFor } from './cli/i18n/messages.js'
import { runIndex } from './cli/index-command.js'
import { runInit } from './cli/init.js'
import { runRules } from './cli/rules-command.js'
import {
  assertProviderChoice,
  pullRequestReviewDeps,
  renderReview,
  reviewRunJson,
} from './cli/review-wiring.js'
export { assertProviderChoice } from './cli/review-wiring.js'
import type { Choice } from './cli/review-wiring.js'
import { toTerminalText } from './cli/terminal-text.js'
import type { TextOutput } from './cli/progress.js'
import type { LocalFileSystem } from './config/local-files.js'
import { resolveProvider, userMcpServers } from './config/merge-config.js'
import { loadUserLayers } from './config/user-config.js'
import type { CreatedReview, CreateReviewOptions } from './github/create-review.js'
import type {
  FetchReviewStateOptions,
  PullRequestReviewState,
} from './github/pull-request-reviews.js'
import { formatPullRequestRef } from './github/pull-request-ref.js'
import type { FetchPullRequestOptions, PullRequest } from './github/pull-request.js'
import type { RepositoryFilesOptions, RepositoryTree } from './github/repository-files.js'
import type { BranchHead, RepositoryInfo } from './github/repository.js'
import type { PullListing } from './github/list-pull-requests.js'
import { runWatch } from './cli/watch-command.js'
import type { Extractor } from './repo-map/extract.js'
import type { GitMirror, GitMirrorOptions } from './repository/git-mirror.js'
import type { IndexStore } from './store/index-store.js'
import type { ObservedStore } from './store/observed-store.js'
import { ClaudeCliProvider } from './providers/claude.js'
import { CodexCliProvider } from './providers/codex.js'
import { OllamaProvider } from './providers/ollama.js'
import type { ReviewProvider } from './providers/types.js'

export interface ProviderOptions {
  model?: string
  userMcpServers?: string[]
  detached?: boolean
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
  listOpenPullRequests: (
    options: RepositoryFilesOptions & { etag?: string },
  ) => Promise<PullListing>
  fetchPullRequestHead: (
    options: FetchPullRequestOptions,
  ) => Promise<{ state: 'open' | 'closed'; draft: boolean; headSha: string }>
  fetchBranchHead: (
    options: RepositoryFilesOptions & { branch: string; etag?: string },
  ) => Promise<BranchHead>
  withLock: <T>(path: string, work: () => Promise<T>) => Promise<T>
  lockHolder: (path: string) => Promise<number | undefined>
  onSignal: (handler: () => void) => void
  killDetachedChildren: () => void
  abort: (code: number) => void
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  clock: () => Date
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
    if (command.kind === 'watch') return await runWatch(command, deps)

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

type ReviewCommand = Extract<CliCommand, { kind: 'review' }>

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
    render: renderReview,
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
