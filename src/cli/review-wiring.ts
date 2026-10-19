import type { PullRequestReviewDeps } from '../app/review-pull-request.js'
import type { PublicationResult, RenderedReview, ReviewRun } from '../app/review-and-publish.js'
import { repositoryCache } from '../config/cache-paths.js'
import { splitRepoName } from '../github/pull-request-ref.js'
import type { PullRequestRef } from '../github/pull-request-ref.js'
import type { PullRequest } from '../github/pull-request.js'
import { RepositoryAccessError } from '../github/repository.js'
import type { ReviewPass } from '../investigation/tools/tool-log.js'
import type { MainDeps } from '../main.js'
import type { SkipReason } from '../publish/types.js'
import type { PublicationPlan } from '../publish/types.js'
import type { ReviewResult } from '../review/types.js'
import { contextSourcesAt } from './context-sources.js'
import { errorSummary } from './format-error.js'
import { formatGitHubReview, formatIgnoredOnlyReview } from './format-github.js'
import { formatContextLine } from './format-context.js'
import { formatImpactLine } from './format-impact.js'
import { formatAlreadyReviewedJson, formatReviewJson } from './format-json.js'
import type { Publication } from './format-json.js'
import { formatRelatedLine } from './format-related.js'
import { messagesFor } from './i18n/messages.js'
import { indexProgress, withProgress } from './progress.js'
import { toTerminalText } from './terminal-text.js'

export type PublishTarget = PullRequestRef & { token: string }
export type Choice = { provider: string; model?: string }

const PROGRESS_LABELS: Readonly<Record<ReviewPass, string>> = {
  review: 'Reviewing',
  verify: 'Verifying findings',
}

export const renderReview = {
  review: (result: ReviewResult, plan: PublicationPlan, language?: string): RenderedReview =>
    formatGitHubReview(result, plan, undefined, messagesFor(language)),
  ignoredOnly: (headSha: string, ignored: readonly string[], language?: string): RenderedReview =>
    formatIgnoredOnlyReview(headSha, ignored, messagesFor(language)),
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
    },
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
