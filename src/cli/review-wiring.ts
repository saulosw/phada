import { trackDetachedChild } from '../process/run-command.js'
import type { McpNameEntry } from '../config/mcp-servers.js'
import { connectMcp } from '../investigation/mcp/mcp-client.js'
import { withoutGitHubTokens } from '../providers/cli-run.js'
import { checkMcpNames } from './mcp-names.js'
import type { CheckedNames, NameCheck } from './mcp-names.js'
import type { FeedbackRefreshDeps } from '../app/feedback.js'
import type { PullRequestReviewDeps } from '../app/review-pull-request.js'
import type { CiReaders } from '../app/read-ci.js'
import type { CheckAnnotation, CheckRun } from '../github/check-runs.js'
import type { CommitStatus } from '../github/commit-statuses.js'
import { JobLogUnavailableError } from '../github/job-log.js'
import type { JobLog } from '../github/job-log.js'
import type {
  PublicationResult,
  RenderedReview,
  ReviewAndPublishEvents,
  ReviewRun,
} from '../app/review-and-publish.js'
import { reportProgress } from '../app/review-progress.js'
import type { ReviewProgressSink } from '../app/review-progress.js'
import { repositoryCache } from '../config/cache-paths.js'
import {
  GitHubPermissionError,
  GitHubRateLimitError,
  PullRequestNotFoundError,
} from '../github/errors.js'
import { splitRepoName } from '../github/pull-request-ref.js'
import type {
  FetchReviewStateOptions,
  PullRequestReviewState,
} from '../github/pull-request-reviews.js'
import type { HistoryStore } from '../store/history-store.js'
import type { PullRequestRef } from '../github/pull-request-ref.js'
import type { PullRequest } from '../github/pull-request.js'
import { RepositoryAccessError } from '../github/repository.js'
import type { LocalFileSystem } from '../config/local-files.js'
import type { RepositoryInfo } from '../github/repository.js'
import type { RepositoryFilesOptions } from '../github/repository-files.js'
import type { BlockedCommand, ReviewProvider } from '../providers/types.js'
import type { Extractor } from '../repo-map/extract.js'
import type { GitMirror, GitMirrorOptions } from '../repository/git-mirror.js'
import type { IndexStore } from '../store/index-store.js'
import type { ObservedStore } from '../store/observed-store.js'
import type { ContextReaders } from './context-sources.js'
import type { ProviderOptions } from './provider-choice.js'
import type { SkipReason } from '../publish/types.js'
import type { CiSummary } from '../context/types.js'
import type { PublicationPlan } from '../publish/types.js'
import type { ReviewResult } from '../review/types.js'
import { contextSourcesAt } from './context-sources.js'
import { errorSummary } from './format-error.js'
import {
  formatGitHubReview,
  formatIgnoredOnlyReview,
  formatResolvedReply,
} from './format-github.js'
import { formatAlreadyReviewedJson, formatReviewJson } from './format-json.js'
import type { Publication } from './format-json.js'
import { messagesFor } from './i18n/messages.js'
import { providerRunsSkills } from './provider-choice.js'
import { readDirResolver } from './read-dirs.js'
import { diskSkillCatalog } from './skill-catalog.js'
import { repositoryReader } from '../github/read-repository.js'
import type { RepositoryReaderOptions } from '../github/read-repository.js'
import type { ReadGitHub } from '../gh-facade/types.js'

export interface ReviewWiringDeps extends ContextReaders, CiReaderDeps {
  env: NodeJS.ProcessEnv
  version: string
  files: LocalFileSystem
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

export interface CiReaderDeps {
  fetchCheckRuns: (options: RepositoryFilesOptions & { sha: string }) => Promise<CheckRun[]>
  fetchCommitStatuses: (
    options: RepositoryFilesOptions & { sha: string },
  ) => Promise<CommitStatus[]>
  fetchCheckAnnotations: (
    options: RepositoryFilesOptions & { checkRunId: number },
  ) => Promise<CheckAnnotation[]>
  fetchJobLog: (options: RepositoryFilesOptions & { jobId: number }) => Promise<JobLog>
}

export type PublishTarget = PullRequestRef & { token: string }

export function ciReaders(deps: CiReaderDeps, { owner, repo, token }: PublishTarget): CiReaders {
  const repository = { owner, repo, token }
  return {
    checkRuns: (sha) => deps.fetchCheckRuns({ ...repository, sha }),
    statuses: (sha) => deps.fetchCommitStatuses({ ...repository, sha }),
    annotations: (checkRunId) => deps.fetchCheckAnnotations({ ...repository, checkRunId }),
    jobLog: (jobId) => deps.fetchJobLog({ ...repository, jobId }),
    permissionDenied: (error) => error instanceof GitHubPermissionError,
    logUnavailable: (error) => error instanceof JobLogUnavailableError,
  }
}
export type Choice = { provider: string; model?: string; mcpNames?: CheckedNames }

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
  review: (
    result: ReviewResult,
    plan: PublicationPlan,
    language?: string,
    ci?: CiSummary,
  ): RenderedReview => formatGitHubReview(result, plan, undefined, messagesFor(language), ci),
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
  progress: ReviewProgressSink,
): PullRequestReviewDeps {
  const { owner, repo, token } = repository
  const cache = repositoryCache(deps.env, deps.home, owner, repo)
  const warning = (message: string) => progress({ kind: 'warning', message })
  const indexing = (total: number) => progress({ kind: 'indexing', total })
  const indexed = (done: number, total: number) => progress({ kind: 'indexed', done, total })
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
    watchProvider: (provider, pass) => reportProgress(provider, pass, progress),
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
      events: { warning, indexing, indexed },
    },
    events: {
      contextLoaded: (report, baseSha) => progress({ kind: 'contextLoaded', report, baseSha }),
      warning,
      indexing,
      indexed,
      impactReady: (report) => progress({ kind: 'impactReady', report }),
      relatedReady: (report) => progress({ kind: 'relatedReady', report }),
      passesPlanned: (plan) => progress({ kind: 'passesPlanned', plan }),
      passStarted: (skill, index, total) => progress({ kind: 'passStarted', skill, index, total }),
    },
  }
}

export function reviewAndPublishEvents(
  progress: ReviewProgressSink,
  reviewed: ReviewAndPublishEvents['reviewed'],
): ReviewAndPublishEvents {
  return {
    fetched: (pullRequest) => progress({ kind: 'fetched', pullRequest }),
    reviewed,
    publishing: () => progress({ kind: 'publishing' }),
    warning: (message) => progress({ kind: 'warning', message }),
    conversationRead: (conversation) => progress({ kind: 'conversationRead', conversation }),
    ciRead: (ci) => progress({ kind: 'ciRead', ci }),
    ciWaiting: (wait) => progress({ kind: 'ciWaiting', wait }),
    ciWaited: (wait) => progress({ kind: 'ciWaited', wait }),
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
  const blocks = {
    ...(reviewed.conversation === undefined ? {} : { conversation: reviewed.conversation }),
    ...(reviewed.ci === undefined ? {} : { ci: reviewed.ci }),
  }
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
      blocks,
    )
  }
  const { plan, rendered } = run
  const { investigation, impact, related, impactText } = reviewed
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
    { ...blocks, ...(impactText === undefined ? {} : { impactText }) },
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
        review: rendered,
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
      return { status: 'failed', error: errorSummary(publication.error), review: rendered }
    default:
      return publication
  }
}

export function mcpNameChecker(deps: ReviewWiringDeps): NameCheck {
  return (
    deps.checkMcpNames ?? ((provider, names) => checkMcpNames(provider, names, { env: deps.env }))
  )
}
