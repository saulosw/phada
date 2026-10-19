import { errorMessage } from '../app/error-message.js'
import { refreshIndex } from '../app/index-repository.js'
import { reviewAndPublish } from '../app/review-and-publish.js'
import type { ReviewRun } from '../app/review-and-publish.js'
import { watchRepositories } from '../app/watch-repositories.js'
import type { WatchDeps } from '../app/watch-repositories.js'
import { repositoryCache } from '../config/cache-paths.js'
import { dataFiles } from '../config/data-paths.js'
import { resolveProvider, userMcpServers } from '../config/merge-config.js'
import { loadTopLevelUserLayers, loadUserLayers } from '../config/user-config.js'
import { historyEnabled, resolveWatchSettings } from '../config/watch-settings.js'
import type { WatchSettings } from '../config/watch-settings.js'
import { splitRepoName } from '../github/pull-request-ref.js'
import type { MainDeps } from '../main.js'
import { MirrorLockTimeoutError } from '../repository/mirror-lock.js'
import type { HistoryStore, JobRecord } from '../store/history-store.js'
import type { IndexFormat } from './args.js'
import { classifyFailure } from './classify-failure.js'
import { MissingGitHubTokenError, UsageError, WatchRunningError } from './errors.js'
import { formatError } from './format-error.js'
import { formatWatchEvent } from './format-watch.js'
import { watchRun } from './history-run.js'
import { assertProviderChoice } from './provider-choice.js'
import { pullRequestReviewDeps, renderReview, reviewRunJson } from './review-wiring.js'
import type { Choice } from './review-wiring.js'
import { printWatchEvents } from './watch-events.js'
import { watchStatusText } from './watch-status.js'
import { ABORTED_EXIT_CODE, createStopControl } from './watch-stop.js'
import type { StopControl } from './watch-stop.js'

export { ABORTED_EXIT_CODE }

export interface WatchCommand {
  once: boolean
  backfill: boolean
  status: boolean
  format: IndexFormat
  debug: boolean
}

export async function runWatch(command: WatchCommand, deps: MainDeps): Promise<number> {
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
  const token = deps.env.GITHUB_TOKEN?.trim() || deps.env.GH_TOKEN?.trim()
  if (!token) throw new MissingGitHubTokenError()
  let locked = false
  try {
    return await deps.withLock(files.lock, () => {
      locked = true
      return watchUnderLock(command, settings, token, deps)
    })
  } catch (error) {
    if (locked || !(error instanceof MirrorLockTimeoutError)) throw error
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
  const stop = createStopControl({
    onSignal: deps.onSignal,
    write: (text) => deps.stderr.write(text),
    killChildren: deps.killDetachedChildren,
    putBack: (job) => history.updateJob(job.id, { status: 'queued' }),
    close: () => history.close(),
  })
  const watched = watchRepositories(
    { settings, backfill: command.backfill, once: command.once },
    watchDeps(settings, token, history, stop, deps),
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
  token: string,
  history: HistoryStore,
  stop: StopControl,
  deps: MainDeps,
): WatchDeps {
  const choices = new Map<number, Choice>()
  const withEtag = (etag: string | undefined) => (etag === undefined ? {} : { etag })
  return {
    history,
    listPulls: (repo, etag) =>
      deps.listOpenPullRequests({ ...splitRepoName(repo), token, ...withEtag(etag) }),
    defaultBranch: async (repo) =>
      (await deps.fetchRepository({ ...splitRepoName(repo), token })).defaultBranch,
    branchHead: (repo, branch, etag) =>
      deps.fetchBranchHead({ ...splitRepoName(repo), branch, token, ...withEtag(etag) }),
    runJob: async (job) => {
      const { run, choice } = await runJob(job, settings, token, deps)
      choices.set(job.id, choice)
      return run
    },
    recordRun: (job, outcome, startedAt) => {
      const choice = choices.get(job.id)
      const meta = {
        source: 'watch' as const,
        jobId: job.id,
        startedAt,
        finishedAt: deps.clock().toISOString(),
        provider: choice?.provider ?? 'unknown',
        ...(choice?.model === undefined ? {} : { model: choice.model }),
      }
      try {
        history.addRun(watchRun(job, outcome, meta, reviewRunJson))
      } catch (error) {
        deps.stderr.write(
          `Warning: could not save the run in the history (${errorMessage(error)}).\n`,
        )
      }
    },
    refreshIndex: (repo, budgetMs) => refreshDefaultBranch(repo, budgetMs, token, deps),
    classify: (error) => classifyFailure(error, deps.clock()),
    now: () => deps.clock(),
    sleep: (ms) => deps.sleep(ms, stop.signal),
    stopRequested: () => stop.stopRequested(),
    events: printWatchEvents(
      (event) => deps.stderr.write(`${formatWatchEvent(event, deps.clock())}\n`),
      stop.track,
    ),
  }
}

async function refreshDefaultBranch(
  repo: string,
  budgetMs: number,
  token: string,
  deps: MainDeps,
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

async function runJob(
  job: JobRecord,
  settings: WatchSettings,
  token: string,
  deps: MainDeps,
): Promise<{ run: ReviewRun; choice: Choice }> {
  const target = splitRepoName(job.repo)
  const userLayers = await loadUserLayers({ ...deps, ...target })
  const choice = resolveProvider({}, userLayers)
  const mcp = userMcpServers(userLayers)
  assertProviderChoice(choice.provider, {
    ...(choice.model === undefined ? {} : { model: choice.model }),
    userMcpServers: mcp,
  })
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
      userMcpServers: mcp,
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
