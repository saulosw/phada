import { errorMessage } from '../app/error-message.js'
import { recordReviewFeedback } from '../app/feedback.js'
import { reviewAndPublish } from '../app/review-and-publish.js'
import type {
  ReviewAndPublishDeps,
  ReviewAndPublishEvents,
  ReviewRun,
} from '../app/review-and-publish.js'
import type { ReviewOptions } from '../app/review-pull-request.js'
import type { ReviewProgressSink } from '../app/review-progress.js'
import type { HistorySave } from '../app/requested-review.js'
import { dataFiles } from '../config/data-paths.js'
import { resolveProvider } from '../config/merge-config.js'
import { resolveMcp, userMcp } from '../config/mcp-servers.js'
import type { ResolvedMcp } from '../config/mcp-servers.js'
import type { ConfigLayer } from '../config/types.js'
import { loadUserLayers } from '../config/user-config.js'
import { historyEnabled } from '../config/watch-settings.js'
import type { ComparedFile, CompareOptions } from '../github/compare-commits.js'
import type { CreatedReview, CreateReviewOptions } from '../github/create-review.js'
import type { PullRequestRef } from '../github/pull-request-ref.js'
import type {
  FetchReviewStateOptions,
  PullComment,
  PullRequestReviewState,
} from '../github/pull-request-reviews.js'
import type { FetchPullRequestOptions, PullRequest } from '../github/pull-request.js'
import type { ReplyAndResolveOptions } from '../github/resolve-thread.js'
import type { HistoryStore } from '../store/history-store.js'
import { historyRun } from './history-run.js'
import type { RunMeta } from './history-run.js'
import { assertProviderChoice } from './provider-choice.js'
import {
  ciReaders,
  mcpNameChecker,
  pullRequestReviewDeps,
  renderReview,
  reviewAndPublishEvents,
  reviewRunJson,
} from './review-wiring.js'
import type { Choice, ReviewWiringDeps } from './review-wiring.js'

export interface ManualReviewDeps extends ReviewWiringDeps {
  fetchPullRequest: (options: FetchPullRequestOptions) => Promise<PullRequest>
  fetchReviewState: (options: FetchReviewStateOptions) => Promise<PullRequestReviewState>
  fetchPullComments: (options: FetchReviewStateOptions) => Promise<PullComment[]>
  createReview: (options: CreateReviewOptions) => Promise<CreatedReview>
  fetchComparison: (options: CompareOptions) => Promise<ComparedFile[]>
  replyAndResolve: (options: ReplyAndResolveOptions) => Promise<void>
  openHistoryStore: (path: string) => Promise<HistoryStore>
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  clock: () => Date
}

export interface PreparedReview {
  ref: PullRequestRef
  token: string
  userLayers: readonly ConfigLayer[]
  choice: Choice & { detached?: boolean }
  mcp: ResolvedMcp
}

export interface ManualReviewInput {
  force: boolean
  dryRun: boolean
  waitCi: boolean
  options: ReviewOptions
}

export interface ManualReviewReport {
  progress: ReviewProgressSink
  reviewed: ReviewAndPublishEvents['reviewed']
}

export interface ManualReview {
  run: ReviewRun
  meta: RunMeta
  history: HistorySave
}

export async function prepareReview(
  ref: PullRequestRef,
  token: string,
  flags: { provider?: string; model?: string; detached?: boolean },
  deps: ManualReviewDeps,
): Promise<PreparedReview> {
  const userLayers = await loadUserLayers({
    env: deps.env,
    home: deps.home,
    owner: ref.owner,
    repo: ref.repo,
    files: deps.files,
  })
  const choice = resolveProvider(
    {
      ...(flags.provider === undefined ? {} : { provider: flags.provider }),
      ...(flags.model === undefined ? {} : { model: flags.model }),
    },
    userLayers,
  )
  const mcp = resolveMcp(userMcp(userLayers), deps.env)
  assertProviderChoice(choice.provider, {
    ...(choice.model === undefined ? {} : { model: choice.model }),
    mcp,
  })
  const mcpNames = await mcpNameChecker(deps)(choice.provider, mcp.names)
  return {
    ref,
    token,
    userLayers,
    choice: {
      ...choice,
      ...(mcpNames === undefined ? {} : { mcpNames }),
      ...(flags.detached === true ? { detached: true } : {}),
    },
    mcp,
  }
}

export async function runManualReview(
  prepared: PreparedReview,
  input: ManualReviewInput,
  deps: ManualReviewDeps,
  report: ManualReviewReport,
): Promise<ManualReview> {
  const startedAt = deps.clock().toISOString()
  const run = await reviewAndPublish(
    {
      ref: prepared.ref,
      mode: 'manual',
      force: input.force,
      dryRun: input.dryRun,
      publish: true,
      ...(input.waitCi ? { waitCi: { since: startedAt } } : {}),
      options: input.options,
      userLayers: prepared.userLayers,
      mcp: prepared.mcp,
    },
    manualReviewDeps(prepared, deps, report),
  )
  const { choice } = prepared
  const meta: RunMeta = {
    source: 'manual',
    startedAt,
    finishedAt: deps.clock().toISOString(),
    provider: choice.provider,
    ...(choice.model === undefined ? {} : { model: choice.model }),
  }
  return { run, meta, history: await saveRun(deps, prepared.userLayers, run, meta) }
}

function manualReviewDeps(
  { ref, token, choice }: PreparedReview,
  deps: ManualReviewDeps,
  { progress, reviewed }: ManualReviewReport,
): ReviewAndPublishDeps {
  const target = { ...ref, token }
  const forever = new AbortController().signal
  return {
    fetchPullRequest: (pull) => deps.fetchPullRequest({ ...pull, token }),
    fetchReviewState: (pull) => deps.fetchReviewState({ ...pull, token }),
    fetchPullComments: (pull) => deps.fetchPullComments({ ...pull, token }),
    ci: ciReaders(deps, target),
    reviewDeps: (pullRequest) => pullRequestReviewDeps(deps, target, choice, pullRequest, progress),
    render: renderReview,
    createReview: (pullRequest, rendered) =>
      deps.createReview({
        ...target,
        commitSha: pullRequest.headSha,
        body: rendered.body,
        comments: rendered.comments,
      }),
    compare: (pullRequest, base) =>
      deps.fetchComparison({
        owner: ref.owner,
        repo: ref.repo,
        token,
        base,
        head: pullRequest.headSha,
      }),
    replyAndResolve: (threadId, body) => deps.replyAndResolve({ token, threadId, body }),
    clock: {
      now: () => deps.clock().toISOString(),
      sleep: (ms) => deps.sleep(ms, forever),
    },
    events: reviewAndPublishEvents(progress, reviewed),
  }
}

async function saveRun(
  deps: ManualReviewDeps,
  userLayers: readonly ConfigLayer[],
  run: ReviewRun,
  meta: RunMeta,
): Promise<HistorySave> {
  if (!historyEnabled(userLayers)) return { status: 'off' }
  let history: HistoryStore
  let runId: number
  try {
    history = await deps.openHistoryStore(dataFiles(deps.env, deps.home).history)
  } catch (error) {
    return { status: 'not-saved', error: errorMessage(error) }
  }
  try {
    try {
      runId = history.addRun(historyRun(run, reviewRunJson(run), meta))
    } catch (error) {
      return { status: 'not-saved', error: errorMessage(error) }
    }
    try {
      recordReviewFeedback(history, run, { runId, source: 'manual', now: meta.finishedAt })
    } catch (error) {
      return { status: 'saved', runId, feedbackError: errorMessage(error) }
    }
    return { status: 'saved', runId }
  } finally {
    history.close()
  }
}
