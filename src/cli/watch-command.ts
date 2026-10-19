import { errorMessage } from '../app/error-message.js'
import { refreshIndex } from '../app/index-repository.js'
import { reviewAndPublish } from '../app/review-and-publish.js'
import type { ReviewRun } from '../app/review-and-publish.js'
import { watchRepositories } from '../app/watch-repositories.js'
import type { RunOutcome, WatchDeps, WatchEvents } from '../app/watch-repositories.js'
import { repositoryCache } from '../config/cache-paths.js'
import { dataFiles } from '../config/data-paths.js'
import { resolveProvider, userMcpServers } from '../config/merge-config.js'
import { loadTopLevelUserLayers, loadUserLayers } from '../config/user-config.js'
import { historyEnabled, resolveWatchSettings } from '../config/watch-settings.js'
import type { WatchSettings } from '../config/watch-settings.js'
import type { MainDeps } from '../main.js'
import { ProviderError } from '../providers/types.js'
import { MirrorLockTimeoutError } from '../repository/mirror-lock.js'
import { InvalidReviewReportError } from '../review/errors.js'
import type { HistoryStore, JobRecord, RunRecord } from '../store/history-store.js'
import type { IndexFormat } from './args.js'
import { classifyFailure } from './classify-failure.js'
import { MissingGitHubTokenError, UsageError, WatchRunningError } from './errors.js'
import { formatError } from './format-error.js'
import { formatWatchEvent, formatWatchStatus, formatWatchStatusJson } from './format-watch.js'
import type { WatchEventView } from './format-watch.js'
import { historyRun } from './history-run.js'
import {
  assertProviderChoice,
  pullRequestReviewDeps,
  renderReview,
  reviewRunJson,
  splitRepo,
} from './review-wiring.js'
import type { Choice } from './review-wiring.js'

export interface WatchCommand {
  once: boolean
  backfill: boolean
  status: boolean
  format: IndexFormat
  debug: boolean
}

export const ABORTED_EXIT_CODE = 130

export async function runWatch(command: WatchCommand, deps: MainDeps): Promise<number> {
  const layers = await loadTopLevelUserLayers(deps)
  const files = dataFiles(deps.env, deps.home)
  if (command.status) {
    const history = await deps.openHistoryStore(files.history)
    try {
      const status = history.status()
      const holder = await deps.lockHolder(files.lock)
      const running = holder === undefined ? undefined : { pid: holder }
      deps.stdout.write(
        command.format === 'json'
          ? formatWatchStatusJson(status, running, deps.clock())
          : formatWatchStatus(status, running, deps.clock()),
      )
    } finally {
      history.close()
    }
    return 0
  }
  const settings = resolveWatchSettings(layers)
  if (settings === undefined)
    throw new UsageError(
      'Nothing to watch: list the repositories under watch: in your own config, e.g. watch: { repos: [owner/repo] } in ~/.config/phada/config.yml.',
    )
  if (!historyEnabled(layers)) {
    throw new UsageError(
      'phada watch needs the history to know what it already reviewed; remove history: false from your config.',
    )
  }
  const token = deps.env.GITHUB_TOKEN?.trim() || deps.env.GH_TOKEN?.trim()
  if (!token) throw new MissingGitHubTokenError()
  try {
    return await deps.withLock(files.lock, () => watchUnderLock(command, settings, token, deps))
  } catch (error) {
    if (!(error instanceof MirrorLockTimeoutError)) throw error
    const holder = await deps.lockHolder(files.lock)
    throw new WatchRunningError(
      `Another phada watch is running${holder === undefined ? '' : ` (PID ${holder})`}.`,
    )
  }
}

async function watchUnderLock(
  command: WatchCommand,
  settings: WatchSettings,
  token: string,
  deps: MainDeps,
): Promise<number> {
  const history = await deps.openHistoryStore(dataFiles(deps.env, deps.home).history)
  const controller = new AbortController()
  let signals = 0
  let current: JobRecord | undefined
  let finishAborted: (code: number) => void = () => undefined
  const aborted = new Promise<number>((resolve) => {
    finishAborted = resolve
  })
  deps.onSignal(() => {
    signals += 1
    if (signals === 1) {
      deps.stderr.write(
        current === undefined
          ? 'Stopping…\n'
          : 'Stopping after the current review (Ctrl-C again to abort).\n',
      )
      controller.abort()
      return
    }
    deps.killDetachedChildren()
    if (current !== undefined) history.updateJob(current.id, { status: 'queued' })
    deps.stderr.write('Aborted.\n')
    history.close()
    finishAborted(ABORTED_EXIT_CODE)
  })

  const print = (event: WatchEventView) =>
    deps.stderr.write(`${formatWatchEvent(event, deps.clock())}\n`)
  const choices = new Map<number, Choice>()
  const events: WatchEvents = {
    cycle: () => undefined,
    baseline: (repo, count) => print({ kind: 'baseline', repo, count }),
    queued: (job) => print({ kind: 'queued', job }),
    superseded: (job) => print({ kind: 'superseded', job }),
    started: (job) => {
      current = job
      print({ kind: 'started', job })
    },
    finished: (job, run) => {
      current = undefined
      print({ kind: 'finished', job, run })
    },
    retry: (job, at, error) => {
      current = undefined
      print({ kind: 'retry', job, at, error })
    },
    paused: (pause) => {
      current = undefined
      print({ kind: 'paused', pause })
    },
    failed: (job, error) => {
      current = undefined
      print({ kind: 'failed', job, error })
    },
    indexed: (repo, sha) => print({ kind: 'indexed', repo, sha }),
    indexPartial: (repo) => print({ kind: 'indexPartial', repo }),
    warning: (message) => print({ kind: 'warning', message }),
  }

  const watchDeps: WatchDeps = {
    history,
    listPulls: (repo, etag) =>
      deps.listOpenPullRequests({
        ...splitRepo(repo),
        token,
        ...(etag === undefined ? {} : { etag }),
      }),
    defaultBranch: async (repo) =>
      (await deps.fetchRepository({ ...splitRepo(repo), token })).defaultBranch,
    branchHead: (repo, branch, etag) =>
      deps.fetchBranchHead({
        ...splitRepo(repo),
        branch,
        token,
        ...(etag === undefined ? {} : { etag }),
      }),
    runJob: async (job) => {
      const run = await runJob(job, settings, token, deps)
      choices.set(job.id, run.choice)
      return run.run
    },
    recordRun: (job, outcome, startedAt) =>
      recordRun(history, job, outcome, startedAt, choices.get(job.id), deps),
    refreshIndex: async (repo, budgetMs) => {
      const target = splitRepo(repo)
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
    },
    classify: (error) => classifyFailure(error, deps.clock()),
    now: () => deps.clock(),
    sleep: (ms) => deps.sleep(ms, controller.signal),
    stopRequested: () => signals > 0,
    events,
  }

  const watched = watchRepositories(
    { settings, backfill: command.backfill, once: command.once },
    watchDeps,
  ).then((exit) => {
    if (signals > 1) return ABORTED_EXIT_CODE
    history.close()
    if (exit.reason === 'fatal') {
      deps.stderr.write(`${formatError(exit.error, { debug: command.debug }).message}\n`)
      return 1
    }
    if (exit.reason === 'stopped') deps.stderr.write('Stopped.\n')
    return 0
  })
  const code = await Promise.race([watched, aborted])
  if (code === ABORTED_EXIT_CODE) deps.abort(ABORTED_EXIT_CODE)
  return code
}

async function runJob(
  job: JobRecord,
  settings: WatchSettings,
  token: string,
  deps: MainDeps,
): Promise<{ run: ReviewRun; choice: Choice }> {
  const target = splitRepo(job.repo)
  const userLayers = await loadUserLayers({ ...deps, ...target })
  const choice = resolveProvider({}, userLayers)
  assertProviderChoice(choice.provider, choice.model === undefined ? {} : { model: choice.model })
  const repo = settings.repos.find((entry) => entry.repo === job.repo)
  const ref = { ...target, number: job.number }
  const publishTarget = { ...ref, token }
  const run = await reviewAndPublish(
    {
      ref,
      mode: 'watch',
      force: false,
      dryRun: false,
      publish: repo?.publish ?? true,
      options: {},
      userLayers,
      userMcpServers: userMcpServers(userLayers),
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
      checkHead: async (pullRequest) => {
        const head = await deps.fetchPullRequestHead({ ...ref, token })
        if (head.state === 'closed' || head.draft) return 'closed'
        return head.headSha === pullRequest.headSha ? 'current' : { superseded: head.headSha }
      },
      events: { fetched: () => undefined, reviewed: () => undefined, publishing: () => undefined },
    },
  )
  return { run, choice }
}

function recordRun(
  history: HistoryStore,
  job: JobRecord,
  outcome: RunOutcome,
  startedAt: string,
  choice: Choice | undefined,
  deps: MainDeps,
): void {
  const meta = {
    source: 'watch' as const,
    jobId: job.id,
    startedAt,
    finishedAt: deps.clock().toISOString(),
    provider: choice?.provider ?? 'unknown',
    ...(choice?.model === undefined ? {} : { model: choice.model }),
  }
  try {
    if ('run' in outcome) {
      history.addRun(historyRun(outcome.run, reviewRunJson(outcome.run), meta))
      return
    }
    const failed: RunRecord = {
      jobId: job.id,
      source: 'watch',
      repo: job.repo,
      number: job.number,
      headSha: job.headSha,
      startedAt,
      finishedAt: meta.finishedAt,
      status: 'failed',
      aiCalled:
        outcome.error instanceof ProviderError || outcome.error instanceof InvalidReviewReportError,
      provider: meta.provider,
      ...(choice?.model === undefined ? {} : { model: choice.model }),
      errorKind: outcome.kind,
      error: errorMessage(outcome.error),
    }
    history.addRun(failed)
  } catch (error) {
    deps.stderr.write(`Warning: could not save the run in the history (${errorMessage(error)}).\n`)
  }
}
