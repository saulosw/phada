import { errorMessage } from '../app/error-message.js'
import { recordReviewFeedback, refreshFeedback } from '../app/feedback.js'
import { refreshIndex } from '../app/index-repository.js'
import { reviewAndPublish } from '../app/review-and-publish.js'
import type { ReviewRun } from '../app/review-and-publish.js'
import type { ReviewProgressSink } from '../app/review-progress.js'
import { BUILT_IN_SKILL, builtInSkillError } from '../app/review-passes.js'
import type { SubmitDeps } from '../app/submit-request.js'
import { watchEventsTo } from '../app/watch-event.js'
import type { WatchEventSink } from '../app/watch-event.js'
import { watchRepositories } from '../app/watch-repositories.js'
import type { WatchDeps, WatchExit } from '../app/watch-repositories.js'
import { repositoryCache } from '../config/cache-paths.js'
import { dataFiles } from '../config/data-paths.js'
import { mergeConfig, resolveProvider } from '../config/merge-config.js'
import { resolveMcp, userMcp } from '../config/mcp-servers.js'
import type { ResolvedMcp } from '../config/mcp-servers.js'
import type { ConfigLayer } from '../config/types.js'
import { loadTopLevelUserLayers, loadUserLayers } from '../config/user-config.js'
import type { WatchSettings } from '../config/watch-settings.js'
import type { ComparedFile, CompareOptions } from '../github/compare-commits.js'
import type { CreatedReview, CreateReviewOptions } from '../github/create-review.js'
import type { CommentListing } from '../github/issue-comments.js'
import type { PullListing } from '../github/list-pull-requests.js'
import { splitRepoName } from '../github/pull-request-ref.js'
import type {
  FetchReviewStateOptions,
  PullComment,
  PullRequestReviewState,
} from '../github/pull-request-reviews.js'
import type {
  FetchPullRequestOptions,
  PullRequest,
  PullRequestMetadata,
} from '../github/pull-request.js'
import type { BranchHead } from '../github/repository.js'
import type { RepositoryFilesOptions } from '../github/repository-files.js'
import type { ReplyAndResolveOptions } from '../github/resolve-thread.js'
import { MirrorLockTimeoutError } from '../repository/mirror-lock.js'
import type { HistoryStore } from '../store/history-store.js'
import { NOT_STARTED } from '../watch/next-job.js'
import { publishOf } from '../watch/request-policy.js'
import type { JobRecord, RequestRecord } from '../watch/types.js'
import { ciGateReader } from './ci-gate-reader.js'
import { classifyFailure } from './classify-failure.js'
import { UsageError, WatchRunningError } from './errors.js'
import { requireGitHubToken } from './github-token.js'
import type { GitHubTokenDeps } from './github-token.js'
import { requestSourceOf, watchRun } from './history-run.js'
import type { CheckedNames, NameCheck } from './mcp-names.js'
import { assertProviderChoice, providerRunsSkills } from './provider-choice.js'
import { sleepUntilNewJob } from './queue-wake.js'
import { requireWatchSettings, submitDeps } from './request-wiring.js'
import { reviewEvent } from './review-event.js'
import { openReviewEventSinks, reviewEventSinkSettings } from './review-event-sinks.js'
import type {
  ReviewEventSink,
  ReviewEventSinkDeps,
  ReviewEventSinkSettings,
} from './review-event-sinks.js'
import {
  ciReaders,
  feedbackRefreshDeps,
  mcpNameChecker,
  pullRequestReviewDeps,
  renderReview,
  reviewAndPublishEvents,
  reviewRunJson,
} from './review-wiring.js'
import type { Choice, ReviewWiringDeps } from './review-wiring.js'
import { diskSkillCatalog } from './skill-catalog.js'
import { createStopControl, trackRunningJob } from './watch-stop.js'
import type { StopControl } from './watch-stop.js'

export interface WatchSessionDeps extends ReviewWiringDeps, GitHubTokenDeps {
  fetchPullRequest: (options: FetchPullRequestOptions) => Promise<PullRequest>
  fetchReviewState: (options: FetchReviewStateOptions) => Promise<PullRequestReviewState>
  fetchPullComments: (options: FetchReviewStateOptions) => Promise<PullComment[]>
  createReview: (options: CreateReviewOptions) => Promise<CreatedReview>
  fetchComparison: (options: CompareOptions) => Promise<ComparedFile[]>
  replyAndResolve: (options: ReplyAndResolveOptions) => Promise<void>
  openHistoryStore: (path: string) => Promise<HistoryStore>
  listOpenPullRequests: (
    options: RepositoryFilesOptions & { etag?: string },
  ) => Promise<PullListing>
  fetchPullRequestMetadata: (options: FetchPullRequestOptions) => Promise<PullRequestMetadata>
  listIssueComments: (
    options: RepositoryFilesOptions & { since: string; etag?: string },
  ) => Promise<CommentListing>
  addCommentReaction: (options: RepositoryFilesOptions & { commentId: number }) => Promise<void>
  fetchPullRequestHead: (
    options: FetchPullRequestOptions,
  ) => Promise<{ state: 'open' | 'closed'; draft: boolean; headSha: string }>
  fetchBranchHead: (
    options: RepositoryFilesOptions & { branch: string; etag?: string },
  ) => Promise<BranchHead>
  withLock: <T>(path: string, work: () => Promise<T>) => Promise<T>
  lockHolder: (path: string) => Promise<number | undefined>
  killDetachedChildren: () => void
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  clock: () => Date
  runHook?: ReviewEventSinkDeps['runHook']
  slackApi?: ReviewEventSinkDeps['slackApi']
  connectSlack?: ReviewEventSinkDeps['connectSlack']
}

export interface WatchStart {
  once: boolean
  backfill: boolean
}

export interface JobProgress {
  review: ReviewProgressSink
  reviewAndPublish: ReviewProgressSink
}

export interface WatchListeners {
  event: WatchEventSink
  warning(message: string): void
  progress(job: JobRecord): JobProgress
}

export type WatchEnd = WatchExit | { reason: 'aborted' }

export interface WatchHandle {
  readonly done: Promise<WatchEnd>
  stop(): void
  abort(): void
  stopRequested(): boolean
  running(): JobRecord | undefined
}

interface WatchSession {
  start: WatchStart
  settings: WatchSettings
  sinkSettings: ReviewEventSinkSettings
  token: string
  check: NameCheck
}

export async function startWatch(
  start: WatchStart,
  deps: WatchSessionDeps,
  listeners: WatchListeners,
): Promise<WatchHandle> {
  const layers = await loadTopLevelUserLayers(deps)
  const settings = requireWatchSettings(layers)
  const token = await requireGitHubToken(deps)
  const sinkSettings = reviewEventSinkSettings(layers, deps.env)
  const check = memoized(mcpNameChecker(deps))
  for (const { repo } of settings.repos) {
    try {
      await jobSetup(repo, deps, check)
    } catch (error) {
      if (!(error instanceof UsageError)) throw error
      throw new UsageError(`${repo}: ${error.message}`)
    }
  }
  const { lock } = dataFiles(deps.env, deps.home)
  const session = { start, settings, sinkSettings, token, check }
  return new Promise<WatchHandle>((resolve, reject) => {
    let locked = false
    let handle: WatchHandle | undefined
    const done: Promise<WatchEnd> = deps.withLock(lock, async () => {
      locked = true
      const opened = await openSession(session, deps, listeners)
      handle = {
        done,
        stop: () => opened.stop.stop(),
        abort: () => opened.stop.abort(),
        stopRequested: () => opened.stop.stopRequested(),
        running: () => opened.stop.running(),
      }
      resolve(handle)
      return opened.run()
    })
    done.catch(async (error: unknown) => {
      if (handle !== undefined) return
      if (locked || !(error instanceof MirrorLockTimeoutError)) return reject(error)
      const holder = await deps.lockHolder(lock)
      reject(
        new WatchRunningError(
          `Another phada watch is running${holder === undefined ? '' : ` (PID ${holder})`}.`,
        ),
      )
    })
  })
}

async function openSession(
  { start, settings, sinkSettings, token, check }: WatchSession,
  deps: WatchSessionDeps,
  listeners: WatchListeners,
): Promise<{ stop: StopControl; run: () => Promise<WatchEnd> }> {
  const history = await deps.openHistoryStore(dataFiles(deps.env, deps.home).history)
  const submit = submitDeps(history, settings, token, deps)
  const opened = openReviewEventSinks(
    sinkSettings,
    {
      history,
      submit,
      listen: !start.once,
      warning: (message) => listeners.event({ kind: 'warning', message }),
    },
    deps,
  )
  const stop = createStopControl({
    killChildren: deps.killDetachedChildren,
    putBack: (job) => history.updateJob(job.id, { status: 'queued' }),
    close: () => {
      opened.close()
      history.close()
    },
  })
  const run = () => {
    const watched = watchRepositories(
      { settings, backfill: start.backfill, once: start.once },
      watchDeps(
        { settings, sinks: opened.sinks, submit, token, history, stop, check, listeners },
        deps,
      ),
    ).then((exit): WatchEnd => {
      if (stop.abortRequested()) return { reason: 'aborted' }
      opened.close()
      history.close()
      return exit
    })
    return Promise.race([watched, stop.aborted.then((): WatchEnd => ({ reason: 'aborted' }))])
  }
  return { stop, run }
}

interface WatchWiring {
  settings: WatchSettings
  sinks: readonly ReviewEventSink[]
  submit: SubmitDeps
  token: string
  history: HistoryStore
  stop: StopControl
  check: NameCheck
  listeners: WatchListeners
}

function watchDeps(
  { settings, sinks, submit, token, history, stop, check, listeners }: WatchWiring,
  deps: WatchSessionDeps,
): WatchDeps {
  const choices = new Map<number, Choice>()
  const events = trackRunningJob(watchEventsTo(listeners.event), stop)
  const withEtag = (etag: string | undefined) => (etag === undefined ? {} : { etag })
  return {
    history,
    listPulls: (repo, etag) =>
      deps.listOpenPullRequests({ ...splitRepoName(repo), token, ...withEtag(etag) }),
    defaultBranch: async (repo) =>
      (await deps.fetchRepository({ ...splitRepoName(repo), token })).defaultBranch,
    branchHead: (repo, branch, etag) =>
      deps.fetchBranchHead({ ...splitRepoName(repo), branch, token, ...withEtag(etag) }),
    submit,
    listComments: (repo, since, etag) =>
      deps.listIssueComments({ ...splitRepoName(repo), token, since, ...withEtag(etag) }),
    react: (repo, commentId) =>
      deps.addCommentReaction({ ...splitRepoName(repo), token, commentId }),
    readCi: ciGateReader(deps, token),
    runJob: async (job, requests) => {
      const setup = await jobSetup(job.repo, deps, check)
      choices.set(job.id, setup.choice)
      const progress = listeners.progress(job)
      return runJob({ job, requests, setup, settings, token, progress }, deps)
    },
    recordRun: (job, outcome, startedAt) => {
      const choice = choices.get(job.id)
      choices.delete(job.id)
      const source = requestSourceOf(history.requests([job.id]))
      const meta = {
        source: 'watch' as const,
        jobId: job.id,
        startedAt,
        finishedAt: deps.clock().toISOString(),
        provider: choice?.provider ?? 'unknown',
        ...(choice?.model === undefined ? {} : { model: choice.model }),
        ...(source === undefined ? {} : { requestSource: source }),
      }
      try {
        const runId = history.addRun(watchRun(job, outcome, meta, reviewRunJson))
        if ('run' in outcome) {
          recordReviewFeedback(history, outcome.run, {
            runId,
            source: 'watch',
            now: meta.finishedAt,
          })
        }
      } catch (error) {
        listeners.warning(`could not save the run in the history (${errorMessage(error)}).`)
      }
    },
    refreshIndex: (repo, budgetMs) => refreshDefaultBranch(repo, budgetMs, token, deps),
    refreshFeedback: async (pulls) => {
      await refreshFeedback(
        pulls,
        'watch',
        feedbackRefreshDeps(
          history,
          token,
          deps,
          {
            observed: (pull, threads) => events.feedback(pull.repo, pull.number, threads),
            warning: (message) => events.warning(message),
          },
          () => stop.stopRequested(),
        ),
      )
    },
    notify: async (event) => {
      if (sinks.length === 0) return
      const run = event.kind === 'started' ? undefined : history.runOfJob(event.job.id)
      const json = reviewEvent(event, run)
      for (const sink of sinks) await sink(json)
    },
    classify: (error) => classifyFailure(error, deps.clock()),
    now: () => deps.clock(),
    sleep: (ms) =>
      sleepUntilNewJob(ms, {
        sleep: (step) => deps.sleep(step, stop.signal),
        readyJobs: () => {
          const now = deps.clock().toISOString()
          return history
            .jobs({ status: NOT_STARTED })
            .filter(({ notBefore }) => notBefore <= now)
            .map(({ id }) => id)
        },
        stopped: () => stop.stopRequested(),
      }),
    stopRequested: () => stop.stopRequested(),
    events,
  }
}

async function refreshDefaultBranch(
  repo: string,
  budgetMs: number,
  token: string,
  deps: WatchSessionDeps,
): Promise<'complete' | 'partial'> {
  const target = splitRepoName(repo)
  const cache = repositoryCache(deps.env, deps.home, target.owner, target.repo)
  const userLayers = await loadUserLayers({ ...deps, ...target })
  const mirror = await deps.openMirror({ dir: cache.mirror, ...target, token, env: deps.env })
  const result = await refreshIndex(
    { ...target, userLayers, deadline: performance.now() + budgetMs },
    {
      mirror,
      openStore: () => deps.openIndexStore(cache.index, deps.version),
      extractor: deps.createExtractor(),
      now: () => performance.now(),
      events: { extracting: () => undefined, extracted: () => undefined },
    },
  )
  return result.complete ? 'complete' : 'partial'
}

interface JobSetup {
  userLayers: ConfigLayer[]
  choice: Choice
  mcp: ResolvedMcp
}

function memoized(check: NameCheck): NameCheck {
  const checked = new Map<string, Promise<CheckedNames | undefined>>()
  return (provider, names) => {
    const key = JSON.stringify([provider, names])
    const known = checked.get(key) ?? check(provider, names)
    checked.set(key, known)
    return known
  }
}

async function jobSetup(repo: string, deps: WatchSessionDeps, check: NameCheck): Promise<JobSetup> {
  const userLayers = await loadUserLayers({ ...deps, ...splitRepoName(repo) })
  const choice = resolveProvider({}, userLayers)
  const mcp = resolveMcp(userMcp(userLayers), deps.env)
  assertProviderChoice(
    choice.provider,
    { ...(choice.model === undefined ? {} : { model: choice.model }), mcp },
    'config',
  )
  const mcpNames = await check(choice.provider, mcp.names)
  const skills = diskSkillCatalog(deps.files, deps.env, deps.home)
  const native = (deps.runsSkills ?? providerRunsSkills)(choice.provider)
  for (const { name, mode } of mergeConfig(userLayers).review.skills?.entries ?? []) {
    if (name === BUILT_IN_SKILL) continue
    const skill = await skills.find(name)
    if (skill.native.kind === 'builtin' && (!native || mode === 'text')) {
      throw builtInSkillError(name)
    }
  }
  return { userLayers, choice: mcpNames === undefined ? choice : { ...choice, mcpNames }, mcp }
}

interface QueuedReview {
  job: JobRecord
  requests: readonly RequestRecord[]
  setup: JobSetup
  settings: WatchSettings
  token: string
  progress: JobProgress
}

async function runJob(
  { job, requests, setup, settings, token, progress }: QueuedReview,
  deps: WatchSessionDeps,
): Promise<ReviewRun> {
  const { userLayers, choice, mcp } = setup
  const target = splitRepoName(job.repo)
  const repo = settings.repos.find((entry) => entry.repo === job.repo)
  const ref = { ...target, number: job.number }
  const publishTarget = { ...ref, token }
  const asked = requests.some(({ source }) => source !== 'watch')
  return reviewAndPublish(
    {
      ref,
      mode: 'watch',
      force: false,
      dryRun: false,
      publish: repo === undefined ? job.publish !== 'none' : publishOf(job, repo) === 'pr',
      acceptDraft: asked,
      options: {},
      userLayers,
      mcp,
    },
    {
      fetchPullRequest: (pull) => deps.fetchPullRequest({ ...pull, token }),
      fetchReviewState: (pull) => deps.fetchReviewState({ ...pull, token }),
      fetchPullComments: (pull) => deps.fetchPullComments({ ...pull, token }),
      ci: ciReaders(deps, publishTarget),
      reviewDeps: (pullRequest) =>
        pullRequestReviewDeps(
          deps,
          publishTarget,
          { ...choice, detached: true },
          pullRequest,
          progress.review,
        ),
      render: renderReview,
      createReview: (pullRequest, rendered) =>
        deps.createReview({
          ...publishTarget,
          commitSha: pullRequest.headSha,
          body: rendered.body,
          comments: rendered.comments,
        }),
      compare: (pullRequest, base) =>
        deps.fetchComparison({ ...target, token, base, head: pullRequest.headSha }),
      replyAndResolve: (threadId, body) => deps.replyAndResolve({ token, threadId, body }),
      checkHead: async (pullRequest) => {
        const head = await deps.fetchPullRequestHead({ ...ref, token })
        if (head.state === 'closed' || (head.draft && !asked)) return 'closed-or-draft'
        return head.headSha === pullRequest.headSha ? 'current' : { superseded: head.headSha }
      },
      events: reviewAndPublishEvents(progress.reviewAndPublish, () => undefined),
    },
  )
}
