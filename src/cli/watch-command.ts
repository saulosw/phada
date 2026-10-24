import { errorMessage } from '../app/error-message.js'
import { recordReviewFeedback, refreshFeedback } from '../app/feedback.js'
import { refreshIndex } from '../app/index-repository.js'
import { reviewAndPublish } from '../app/review-and-publish.js'
import type { ReviewRun } from '../app/review-and-publish.js'
import { watchRepositories } from '../app/watch-repositories.js'
import type { WatchDeps } from '../app/watch-repositories.js'
import { repositoryCache } from '../config/cache-paths.js'
import { dataFiles } from '../config/data-paths.js'
import { mergeConfig, resolveProvider } from '../config/merge-config.js'
import { resolveMcp, userMcp } from '../config/mcp-servers.js'
import { BUILT_IN_SKILL, builtInSkillError } from '../app/review-passes.js'
import { loadTopLevelUserLayers, loadUserLayers } from '../config/user-config.js'
import {
  historyEnabled,
  resolveHookSettings,
  resolveWatchSettings,
} from '../config/watch-settings.js'
import type { HookSettings, WatchSettings } from '../config/watch-settings.js'
import { splitRepoName } from '../github/pull-request-ref.js'
import type { ConfigLayer } from '../config/types.js'
import type { ComparedFile, CompareOptions } from '../github/compare-commits.js'
import type { CreatedReview, CreateReviewOptions } from '../github/create-review.js'
import type { ReplyAndResolveOptions } from '../github/resolve-thread.js'
import type { PullListing } from '../github/list-pull-requests.js'
import type {
  FetchReviewStateOptions,
  PullRequestReviewState,
} from '../github/pull-request-reviews.js'
import type {
  FetchPullRequestOptions,
  PullRequest,
  PullRequestMetadata,
} from '../github/pull-request.js'
import type { BranchHead } from '../github/repository.js'
import type { RepositoryFilesOptions } from '../github/repository-files.js'
import type { TextOutput } from './progress.js'
import { MirrorLockTimeoutError } from '../repository/mirror-lock.js'
import type { HistoryStore } from '../store/history-store.js'
import type { JobRecord, RequestRecord } from '../watch/types.js'
import type { IndexFormat } from './args.js'
import { classifyFailure } from './classify-failure.js'
import { MissingGitHubTokenError, UsageError, WatchRunningError } from './errors.js'
import { formatError } from './format-error.js'
import { formatWatchEvent } from './format-watch.js'
import { watchRun } from './history-run.js'
import { assertProviderChoice, providerRunsSkills } from './provider-choice.js'
import { diskSkillCatalog } from './skill-catalog.js'
import {
  feedbackRefreshDeps,
  pullRequestReviewDeps,
  renderReview,
  reviewRunJson,
} from './review-wiring.js'
import { mcpNameChecker } from './review-wiring.js'
import type { Choice, ReviewWiringDeps } from './review-wiring.js'
import type { CheckedNames, NameCheck } from './mcp-names.js'
import type { McpNameEntry, ResolvedMcp } from '../config/mcp-servers.js'
import { reviewEvent } from './review-event.js'
import { runHook } from './run-hook.js'
import { printWatchEvents } from './watch-events.js'
import { watchStatusText } from './watch-status.js'
import { ABORTED_EXIT_CODE, createStopControl, trackRunningJob } from './watch-stop.js'
import type { StopControl } from './watch-stop.js'

export { ABORTED_EXIT_CODE }

export interface WatchCommandDeps extends ReviewWiringDeps {
  stdout: TextOutput
  fetchPullRequest: (options: FetchPullRequestOptions) => Promise<PullRequest>
  fetchReviewState: (options: FetchReviewStateOptions) => Promise<PullRequestReviewState>
  createReview: (options: CreateReviewOptions) => Promise<CreatedReview>
  fetchComparison: (options: CompareOptions) => Promise<ComparedFile[]>
  replyAndResolve: (options: ReplyAndResolveOptions) => Promise<void>
  openHistoryStore: (path: string) => Promise<HistoryStore>
  listOpenPullRequests: (
    options: RepositoryFilesOptions & { etag?: string },
  ) => Promise<PullListing>
  fetchPullRequestMetadata: (options: FetchPullRequestOptions) => Promise<PullRequestMetadata>
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
  runHook?: typeof runHook
}

export interface WatchCommand {
  once: boolean
  backfill: boolean
  status: boolean
  format: IndexFormat
  debug: boolean
}

export async function runWatch(command: WatchCommand, deps: WatchCommandDeps): Promise<number> {
  const layers = await loadTopLevelUserLayers(deps)
  const files = dataFiles(deps.env, deps.home)
  if (command.status) {
    const history = await deps.openHistoryStore(files.history)
    try {
      const holder = await deps.lockHolder(files.lock)
      deps.stdout.write(watchStatusText(history, layers, holder, deps.clock(), command.format))
    } finally {
      history.close()
    }
    return 0
  }
  const settings = requireWatchSettings(layers)
  const token = deps.env.GITHUB_TOKEN?.trim() || deps.env.GH_TOKEN?.trim()
  if (!token) throw new MissingGitHubTokenError()
  const check = memoized(mcpNameChecker(deps))
  for (const { repo } of settings.repos) {
    try {
      await jobSetup(repo, deps, check)
    } catch (error) {
      if (!(error instanceof UsageError)) throw error
      throw new UsageError(`${repo}: ${error.message}`)
    }
  }
  let locked = false
  try {
    return await deps.withLock(files.lock, () => {
      locked = true
      return watchUnderLock(command, settings, resolveHookSettings(layers), token, deps, check)
    })
  } catch (error) {
    if (locked || !(error instanceof MirrorLockTimeoutError)) throw error
    const holder = await deps.lockHolder(files.lock)
    throw new WatchRunningError(
      `Another phada watch is running${holder === undefined ? '' : ` (PID ${holder})`}.`,
    )
  }
}

export function requireWatchSettings(layers: readonly ConfigLayer[]): WatchSettings {
  const settings = resolveWatchSettings(layers)
  if (settings === undefined) {
    throw new UsageError(
      'Nothing to watch: list the repositories under watch: in your own config, e.g. watch: { repos: [owner/repo] } in ~/.config/phada/config.yml.',
    )
  }
  if (!historyEnabled(layers)) {
    throw new UsageError(
      'phada watch needs the history to know what it already reviewed; remove history: false from your config.',
    )
  }
  return settings
}

async function watchUnderLock(
  command: WatchCommand,
  settings: WatchSettings,
  hooks: HookSettings | undefined,
  token: string,
  deps: WatchCommandDeps,
  check: NameCheck,
): Promise<number> {
  const history = await deps.openHistoryStore(dataFiles(deps.env, deps.home).history)
  const stop = createStopControl({
    onSignal: deps.onSignal,
    write: (text) => deps.stderr.write(text),
    killChildren: deps.killDetachedChildren,
    putBack: (job) => history.updateJob(job.id, { status: 'queued' }),
    close: () => history.close(),
  })
  const watched = watchRepositories(
    { settings, backfill: command.backfill, once: command.once },
    watchDeps(settings, hooks, token, history, stop, deps, check),
  ).then((exit) => {
    if (stop.abortedTwice()) return ABORTED_EXIT_CODE
    history.close()
    if (exit.reason === 'fatal') {
      deps.stderr.write(`${formatError(exit.error, { debug: command.debug }).message}\n`)
      return 1
    }
    if (exit.reason === 'stopped') deps.stderr.write('Stopped.\n')
    return 0
  })
  const code = await Promise.race([watched, stop.aborted])
  if (code === ABORTED_EXIT_CODE) deps.abort(ABORTED_EXIT_CODE)
  return code
}

function watchDeps(
  settings: WatchSettings,
  hooks: HookSettings | undefined,
  token: string,
  history: HistoryStore,
  stop: StopControl,
  deps: WatchCommandDeps,
  check: NameCheck,
): WatchDeps {
  const choices = new Map<number, Choice>()
  const events = trackRunningJob(
    printWatchEvents((event) => deps.stderr.write(`${formatWatchEvent(event, deps.clock())}\n`)),
    stop,
  )
  const withEtag = (etag: string | undefined) => (etag === undefined ? {} : { etag })
  return {
    history,
    listPulls: (repo, etag) =>
      deps.listOpenPullRequests({ ...splitRepoName(repo), token, ...withEtag(etag) }),
    defaultBranch: async (repo) =>
      (await deps.fetchRepository({ ...splitRepoName(repo), token })).defaultBranch,
    branchHead: (repo, branch, etag) =>
      deps.fetchBranchHead({ ...splitRepoName(repo), branch, token, ...withEtag(etag) }),
    readPull: (repo, number) =>
      deps.fetchPullRequestMetadata({ ...splitRepoName(repo), number, token }),
    runJob: async (job, requests) => {
      const setup = await jobSetup(job.repo, deps, check)
      choices.set(job.id, setup.choice)
      return runJob(job, requests, setup, settings, token, deps)
    },
    recordRun: (job, outcome, startedAt) => {
      const choice = choices.get(job.id)
      choices.delete(job.id)
      const meta = {
        source: 'watch' as const,
        jobId: job.id,
        startedAt,
        finishedAt: deps.clock().toISOString(),
        provider: choice?.provider ?? 'unknown',
        ...(choice?.model === undefined ? {} : { model: choice.model }),
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
        deps.stderr.write(
          `Warning: could not save the run in the history (${errorMessage(error)}).\n`,
        )
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
      if (hooks === undefined) return
      const run = event.kind === 'started' ? undefined : history.runOfJob(event.job.id)
      const warning = await (deps.runHook ?? runHook)(reviewEvent(event, run), hooks, deps.env)
      if (warning !== undefined) events.warning(warning)
    },
    classify: (error) => classifyFailure(error, deps.clock()),
    now: () => deps.clock(),
    sleep: (ms) => deps.sleep(ms, stop.signal),
    stopRequested: () => stop.stopRequested(),
    events,
  }
}

async function refreshDefaultBranch(
  repo: string,
  budgetMs: number,
  token: string,
  deps: WatchCommandDeps,
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

async function jobSetup(repo: string, deps: WatchCommandDeps, check: NameCheck): Promise<JobSetup> {
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

async function runJob(
  job: JobRecord,
  requests: readonly RequestRecord[],
  { userLayers, choice, mcp }: JobSetup,
  settings: WatchSettings,
  token: string,
  deps: WatchCommandDeps,
): Promise<ReviewRun> {
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
      publish: job.publish === undefined ? (repo?.publish ?? true) : job.publish === 'pr',
      acceptDraft: asked,
      options: {},
      userLayers,
      mcp,
    },
    {
      fetchPullRequest: (pull) => deps.fetchPullRequest({ ...pull, token }),
      fetchReviewState: (pull) => deps.fetchReviewState({ ...pull, token }),
      reviewDeps: (pullRequest) =>
        pullRequestReviewDeps(deps, publishTarget, { ...choice, detached: true }, pullRequest),
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
      events: {
        fetched: () => undefined,
        reviewed: () => undefined,
        publishing: () => undefined,
        warning: () => undefined,
      },
    },
  )
}
