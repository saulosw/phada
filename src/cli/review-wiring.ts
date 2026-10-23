import { trackDetachedChild } from '../process/run-command.js'
import type { McpNameEntry } from '../config/mcp-servers.js'
import { connectMcp } from '../investigation/mcp/mcp-client.js'
import { withoutGitHubTokens } from '../providers/cli-run.js'
import { checkMcpNames } from './mcp-names.js'
import type { CheckedNames, NameCheck } from './mcp-names.js'
import type { FeedbackRefreshDeps } from '../app/feedback.js'
import type { PullRequestReviewDeps } from '../app/review-pull-request.js'
import type { PublicationResult, RenderedReview, ReviewRun } from '../app/review-and-publish.js'
import { repositoryCache } from '../config/cache-paths.js'
import { GitHubRateLimitError, PullRequestNotFoundError } from '../github/errors.js'
import { splitRepoName } from '../github/pull-request-ref.js'
import type {
  FetchReviewStateOptions,
  PullRequestReviewState,
} from '../github/pull-request-reviews.js'
import type { HistoryStore } from '../store/history-store.js'
import type { PullRequestRef } from '../github/pull-request-ref.js'
import type { PullRequest } from '../github/pull-request.js'
import { RepositoryAccessError } from '../github/repository.js'
import type { ReviewPass } from '../investigation/tools/tool-log.js'
import type { LocalFileSystem } from '../config/local-files.js'
import type { RepositoryInfo } from '../github/repository.js'
import type { RepositoryFilesOptions } from '../github/repository-files.js'
import type { BlockedCommand, ReviewProvider } from '../providers/types.js'
import type { Extractor } from '../repo-map/extract.js'
import type { GitMirror, GitMirrorOptions } from '../repository/git-mirror.js'
import type { IndexStore } from '../store/index-store.js'
import type { ObservedStore } from '../store/observed-store.js'
import type { ContextReaders } from './context-sources.js'
import type { TextOutput } from './progress.js'
import type { ProviderOptions } from './provider-choice.js'
import type { SkipReason } from '../publish/types.js'
import type { PublicationPlan } from '../publish/types.js'
import type { ReviewResult } from '../review/types.js'
import { contextSourcesAt } from './context-sources.js'
import { errorSummary } from './format-error.js'
import {
  formatGitHubReview,
  formatIgnoredOnlyReview,
  formatResolvedReply,
} from './format-github.js'
import { formatContextLine } from './format-context.js'
import { formatImpactLine } from './format-impact.js'
import { formatAlreadyReviewedJson, formatReviewJson } from './format-json.js'
import type { Publication } from './format-json.js'
import { formatPassesLine } from './format-passes.js'
import { formatRelatedLine } from './format-related.js'
import { messagesFor } from './i18n/messages.js'
import { indexProgress, withProgress } from './progress.js'
import { providerRunsSkills } from './provider-choice.js'
import { readDirResolver } from './read-dirs.js'
import { diskSkillCatalog } from './skill-catalog.js'
import { repositoryReader } from '../github/read-repository.js'
import type { RepositoryReaderOptions } from '../github/read-repository.js'
import type { ReadGitHub } from '../gh-facade/types.js'
import { toTerminalText } from './terminal-text.js'

export interface ReviewWiringDeps extends ContextReaders {
  env: NodeJS.ProcessEnv
  version: string
  files: LocalFileSystem
  stderr: TextOutput
  fetchRepository: (options: RepositoryFilesOptions) => Promise<RepositoryInfo>
  openMirror: (options: GitMirrorOptions) => Promise<GitMirror>
  openIndexStore: (path: string, version: string) => Promise<IndexStore>
  openObservedStore: (path: string) => Promise<ObservedStore>
  createExtractor: () => Extractor
  createProvider: (name: string, options: ProviderOptions) => ReviewProvider
  repositoryReader?: (options: RepositoryReaderOptions) => ReadGitHub
  runsSkills?: (provider: string) => boolean
  openNativeRunner?: PullRequestReviewDeps['openNativeRunner']
  checkMcpNames?: NameCheck
}

export type PublishTarget = PullRequestRef & { token: string }
export type Choice = { provider: string; model?: string; mcpNames?: CheckedNames }

const PROGRESS_LABELS: Readonly<Record<ReviewPass, string>> = {
  review: 'Reviewing',
  verify: 'Verifying findings',
  recheck: 'Rechecking open comments',
}

export interface FeedbackWiringDeps {
  fetchReviewState: (options: FetchReviewStateOptions) => Promise<PullRequestReviewState>
  clock: () => Date
}

export function feedbackRefreshDeps(
  history: HistoryStore,
  token: string,
  deps: FeedbackWiringDeps,
  events: FeedbackRefreshDeps['events'],
  stopRequested?: () => boolean,
): FeedbackRefreshDeps {
  return {
    history,
    ...(stopRequested === undefined ? {} : { stopRequested }),
    fetchReviewState: (pull) =>
      deps.fetchReviewState({ ...splitRepoName(pull.repo), number: pull.number, token }),
    isNotFound: (error) => error instanceof PullRequestNotFoundError,
    isRateLimited: (error) => error instanceof GitHubRateLimitError,
    now: () => deps.clock().toISOString(),
    events,
  }
}

export const renderReview = {
  review: (result: ReviewResult, plan: PublicationPlan, language?: string): RenderedReview =>
    formatGitHubReview(result, plan, undefined, messagesFor(language)),
  ignoredOnly: (
    headSha: string,
    ignored: readonly string[],
    language: string | undefined,
    diff: string,
  ): RenderedReview => formatIgnoredOnlyReview(headSha, ignored, messagesFor(language), diff),
  resolvedReply: (headSha: string, reason: string, language?: string): string =>
    formatResolvedReply(headSha, reason, messagesFor(language)),
}

export function pullRequestReviewDeps(
  deps: ReviewWiringDeps,
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
    createProvider: (useNames) =>
      deps.createProvider(choice.provider, {
        ...(choice.model === undefined ? {} : { model: choice.model }),
        ...(choice.detached === true ? { detached: true } : {}),
        ...(useNames && choice.mcpNames !== undefined ? { mcpNames: choice.mcpNames } : {}),
      }),
    connectMcp: (server) =>
      connectMcp(server, {
        env: withoutGitHubTokens(deps.env),
        clientVersion: deps.version,
        ...(choice.detached === true ? { detached: true, trackChild: trackDetachedChild } : {}),
      }),
    watchProvider: (provider, pass) => withProgress(provider, deps.stderr, PROGRESS_LABELS[pass]),
    skills: diskSkillCatalog(deps.files, deps.env, deps.home),
    runsSkills: (deps.runsSkills ?? providerRunsSkills)(choice.provider),
    readGitHub: (deps.repositoryReader ?? repositoryReader)({ repo: `${owner}/${repo}`, token }),
    env: deps.env,
    resolveDir: readDirResolver(deps.files, deps.home),
    ...(deps.openNativeRunner === undefined ? {} : { openNativeRunner: deps.openNativeRunner }),
    related: {
      readRepository: (name) =>
        deps.fetchRepository({ ...splitRepoName(name), token }).catch((error: unknown) => {
          if (error instanceof RepositoryAccessError) return 'no-access' as const
          throw error
        }),
      openRelated: (name) => {
        const target = splitRepoName(name)
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
      passesPlanned: (plan) => deps.stderr.write(`${formatPassesLine(plan)}\n`),
      passStarted: (skill, index, total) => {
        if (total > 1)
          deps.stderr.write(`${toTerminalText(`Skill ${index + 1}/${total}: ${skill}`)}\n`)
      },
    },
  }
}

export function reviewRunJson(
  run: ReviewRun,
  fixFor?: (blocked: BlockedCommand) => string,
): string {
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
    return formatReviewJson(
      pullRequest,
      reviewed.outcome,
      publication,
      context,
      null,
      null,
      null,
      reviewed.recheck ?? null,
      fixFor,
    )
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
    reviewed.recheck ?? null,
    fixFor,
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
      return {
        status: 'published',
        url: publication.url,
        ...counts,
        resolved: publication.resolved,
      }
    case 'dry-run':
      return {
        status: 'dry-run',
        review: rendered,
        stillOpen: counts.stillOpen,
        dismissed: counts.dismissed,
        ...(wouldSkip === undefined ? {} : { wouldSkip }),
        wouldResolve: publication.wouldResolve,
      }
    case 'failed':
      return { status: 'failed', error: errorSummary(publication.error) }
    default:
      return publication
  }
}

export function mcpNameChecker(deps: ReviewWiringDeps): NameCheck {
  return (
    deps.checkMcpNames ?? ((provider, names) => checkMcpNames(provider, names, { env: deps.env }))
  )
}
