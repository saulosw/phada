import { reviewAndPublish } from './app/review-and-publish.js'
import type {
  PublicationResult,
  ReviewAndPublishDeps,
  ReviewRun,
} from './app/review-and-publish.js'
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

type ReviewedOutcome = Extract<ReviewOutcome, { status: 'reviewed' }>
type PublishTarget = PullRequestRef & { token: string }

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

function printRun(deps: MainDeps, command: ReviewCommand, run: ReviewRun): void {
  const json = command.format === 'json'
  const { pullRequest } = run
  if (run.status === 'skipped') {
    deps.stderr.write(`${formatSkipMessage(pullRequest.headSha, run.reason)}\n`)
    if (json) deps.stdout.write(formatAlreadyReviewedJson(pullRequest, run.reason))
    return
  }
  const { reviewed } = run
  const messages = messagesFor(reviewed.language)
  const context = reviewed.context.report
  if (run.status === 'nothing') {
    const { outcome } = reviewed
    if (run.rendered === undefined || run.publication === undefined) {
      if (json) deps.stdout.write(formatReviewJson(pullRequest, outcome, null, context))
      return
    }
    const note = run.rendered
    finishPublication(deps, run.publication, {
      json,
      dryRun: () =>
        deps.stdout.write(
          json
            ? formatReviewJson(
                pullRequest,
                outcome,
                { status: 'dry-run', review: note, stillOpen: 0 },
                context,
              )
            : formatGitHubPreview(note, messages),
        ),
      jsonOf: (publication) => formatReviewJson(pullRequest, outcome, publication, context),
      comments: 0,
      stillOpen: 0,
      dismissed: 0,
    })
    return
  }
  const outcome = reviewed.outcome as ReviewedOutcome
  const { plan, rendered } = run
  const { investigation, impact, related } = reviewed
  const full = (publication: Publication | null) =>
    formatReviewJson(pullRequest, outcome, publication, context, investigation, impact, related)
  finishPublication(deps, run.publication, {
    json,
    dryRun: () => {
      deps.stdout.write(
        json
          ? full({
              status: 'dry-run',
              review: rendered,
              stillOpen: plan.stillOpen.length,
              dismissed: plan.dismissed.length,
              ...(run.wouldSkip === undefined ? {} : { wouldSkip: run.wouldSkip }),
            })
          : `${formatGitHubPreview(rendered, messages)}\n${formatContextSection(context)}\n${formatImpactSection(impact, reviewed.impactText)}\n${related.status === 'none' ? '' : `${formatRelatedSection(related)}\n`}${formatInvestigationSection(investigation)}`,
      )
    },
    afterDryRun: () => {
      if (run.wouldSkip !== undefined) {
        deps.stderr.write(
          `Without --dry-run: ${formatSkipMessage(pullRequest.headSha, run.wouldSkip)}\n`,
        )
      }
    },
    jsonOf: full,
    comments: rendered.comments.length,
    stillOpen: plan.stillOpen.length,
    dismissed: plan.dismissed.length,
  })
}

interface PublicationOutput {
  json: boolean
  dryRun: () => void
  afterDryRun?: () => void
  jsonOf: (publication: Publication) => string
  comments: number
  stillOpen: number
  dismissed: number
}

function finishPublication(
  deps: MainDeps,
  publication: PublicationResult,
  output: PublicationOutput,
): void {
  switch (publication.status) {
    case 'dry-run':
      output.dryRun()
      deps.stderr.write('Dry run: nothing was posted.\n')
      output.afterDryRun?.()
      return
    case 'failed':
      if (output.json) {
        deps.stdout.write(
          output.jsonOf({ status: 'failed', error: errorSummary(publication.error) }),
        )
      }
      throw publication.error
    case 'published': {
      const { comments, stillOpen, dismissed } = output
      if (output.json) {
        deps.stdout.write(
          output.jsonOf({
            status: 'published',
            url: publication.url,
            comments,
            stillOpen,
            dismissed,
          }),
        )
      }
      deps.stderr.write(
        `${formatPublishedMessage(publication.url, comments, stillOpen, dismissed)}\n`,
      )
      return
    }
    default:
      return
  }
}
