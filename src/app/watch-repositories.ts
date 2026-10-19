import type { WatchedRepoSettings, WatchSettings } from '../config/watch-settings.js'
import type { PullListing } from '../github/list-pull-requests.js'
import type { BranchHead } from '../github/repository.js'
import type { FailureKind, HistoryStore, JobRecord, PauseState } from '../store/history-store.js'
import { afterFailure, MAX_ATTEMPTS, rateLimitPause } from '../watch/failures.js'
import { later } from '../watch/time.js'
import { pickNext, RATE_WINDOW_MS } from '../watch/next-job.js'
import { planCycle } from '../watch/plan-cycle.js'
import type { CycleAction } from '../watch/plan-cycle.js'
import { errorMessage } from './error-message.js'
import type { ReviewRun } from './review-and-publish.js'

export const IDLE_INDEX_BUDGET_MS = 60_000

export interface Failure {
  kind: FailureKind
  resetAt?: string
}
const MIN_SLEEP_MS = 1_000

export interface WatchInput {
  settings: WatchSettings
  backfill: boolean
  once: boolean
}

export type WatchExit = { reason: 'once' | 'stopped' } | { reason: 'fatal'; error: unknown }

export type RunOutcome = { run: ReviewRun } | { error: unknown; kind: FailureKind }

export interface WatchEvents {
  cycle(repo: string, pulls: number): void
  baseline(repo: string, count: number): void
  queued(job: JobRecord): void
  superseded(job: JobRecord): void
  started(job: JobRecord): void
  finished(job: JobRecord, run: ReviewRun): void
  retry(job: JobRecord, at: string, error: unknown): void
  paused(pause: PauseState): void
  failed(job: JobRecord, error: unknown): void
  indexed(repo: string, sha: string): void
  indexPartial(repo: string): void
  warning(message: string): void
  limited(count: number, until: string): void
}

export interface WatchDeps {
  history: HistoryStore
  listPulls(repo: string, etag?: string): Promise<PullListing>
  defaultBranch(repo: string): Promise<string | undefined>
  branchHead(repo: string, branch: string, etag?: string): Promise<BranchHead>
  runJob(job: JobRecord): Promise<ReviewRun>
  recordRun(job: JobRecord, outcome: RunOutcome, startedAt: string): void
  refreshIndex(repo: string, budgetMs: number): Promise<'complete' | 'partial'>
  classify(error: unknown): Failure
  now(): Date
  sleep(ms: number): Promise<void>
  stopRequested(): boolean
  events: WatchEvents
}

export async function watchRepositories(input: WatchInput, deps: WatchDeps): Promise<WatchExit> {
  const { history } = deps
  const { settings } = input
  history.recoverRunning(MAX_ATTEMPTS, iso(deps))
  const branches = new Map<string, string | undefined>()
  let limitedUntil: string | undefined
  let firstPass = true
  for (const repo of settings.repos) {
    const baselineAt = history.repo(repo.repo)?.baselineAt
    if (input.backfill && baselineAt !== undefined) {
      deps.events.warning(
        `${repo.repo}: --backfill only applies the first time a repository is seen; its open pull requests were recorded as they were on ${baselineAt.slice(0, 10)}.`,
      )
    }
  }
  for (;;) {
    if (deps.stopRequested()) return { reason: 'stopped' }
    for (const repo of settings.repos) {
      if (deps.stopRequested()) return { reason: 'stopped' }
      const exit = await discover(repo, input, deps, input.once && firstPass)
      if (exit !== undefined) return exit
    }
    firstPass = false
    if (deps.stopRequested()) return { reason: 'stopped' }
    const now = iso(deps)
    const watchRunsLastHour = history.watchRunsSince(later(now, -RATE_WINDOW_MS))
    const next = pickNext({
      queued: history.jobs({ status: ['queued'] }),
      now,
      ...pauseOf(history),
      watchRunsLastHour,
      maxPerHour: settings.maxReviewsPerHour,
    })
    if (!('job' in next) && next.reason === 'hourly-limit' && next.waitUntil !== limitedUntil) {
      limitedUntil = next.waitUntil
      if (next.waitUntil !== undefined)
        deps.events.limited(watchRunsLastHour.length, next.waitUntil)
    }
    if ('job' in next) {
      const exit = await runJob(next.job, deps)
      if (exit !== undefined) return exit
      continue
    }
    for (const repo of settings.repos) {
      if (deps.stopRequested()) return { reason: 'stopped' }
      await refreshIdle(repo.repo, settings, branches, deps)
    }
    if (input.once) return { reason: 'once' }
    const wake = nextWake(settings, history, next.waitUntil)
    await deps.sleep(Math.max(MIN_SLEEP_MS, Date.parse(wake) - deps.now().getTime()))
  }
}

async function discover(
  repo: WatchedRepoSettings,
  input: WatchInput,
  deps: WatchDeps,
  always: boolean,
): Promise<WatchExit | undefined> {
  const { history } = deps
  const record = history.repo(repo.repo) ?? { repo: repo.repo }
  const now = iso(deps)
  const due =
    always ||
    record.checkedAt === undefined ||
    later(record.checkedAt, input.settings.intervalMs) <= now
  if (!due) {
    return undefined
  }
  let listing: PullListing
  try {
    listing = await deps.listPulls(repo.repo, record.pullsEtag)
  } catch (error) {
    const { kind, resetAt } = deps.classify(error)
    if (kind === 'fatal') return { reason: 'fatal', error }
    if (kind === 'rate-limit') pauseQueue(deps, rateLimitPause(now, resetAt))
    deps.events.warning(`${repo.repo}: ${errorMessage(error)}`)
    history.saveRepo({ ...record, checkedAt: now })
    return undefined
  }
  if (listing.status === 'not-modified') {
    history.saveRepo({ ...record, checkedAt: now })
    return undefined
  }
  deps.events.cycle(repo.repo, listing.pulls.length)
  const actions = planCycle({
    repo,
    pulls: listing.pulls,
    stored: history.pulls(repo.repo),
    jobs: history.jobs({ repo: repo.repo }),
    baselineDone: record.baselineAt !== undefined,
    backfill: input.backfill,
    now,
    settleMs: input.settings.settleMs,
  })
  for (const action of actions) apply(action, repo.repo, now, deps)
  const { pullsEtag: _old, ...rest } = record
  history.saveRepo({
    ...rest,
    ...(listing.etag === undefined ? {} : { pullsEtag: listing.etag }),
    checkedAt: now,
    baselineAt: record.baselineAt ?? now,
  })
  return undefined
}

function apply(action: CycleAction, repo: string, now: string, deps: WatchDeps): void {
  const { history, events } = deps
  switch (action.kind) {
    case 'baseline':
      for (const pull of action.pulls) history.savePull(pull)
      events.baseline(repo, action.pulls.length)
      return
    case 'seen':
      history.savePull(action.pull)
      return
    case 'enqueue': {
      const id = history.addJob(action.job)
      events.queued({ ...action.job, id })
      return
    }
    case 'supersede': {
      history.updateJob(action.jobId, { status: 'superseded', finishedAt: now })
      const job = history.jobs({ repo, status: ['superseded'] }).find((j) => j.id === action.jobId)
      if (job !== undefined) events.superseded(job)
      return
    }
    case 'gone':
      history.savePull(action.pull)
      for (const id of action.jobIds) {
        history.updateJob(id, { status: 'skipped', reason: 'closed', finishedAt: now })
      }
  }
}

async function runJob(job: JobRecord, deps: WatchDeps): Promise<WatchExit | undefined> {
  const { history, events } = deps
  const startedAt = iso(deps)
  history.updateJob(job.id, { status: 'running', startedAt })
  const running = { ...job, status: 'running' as const, startedAt }
  events.started(running)
  let run: ReviewRun
  try {
    run = await deps.runJob(running)
  } catch (error) {
    const failure = deps.classify(error)
    deps.recordRun(running, { error, kind: failure.kind }, startedAt)
    return fail(running, error, failure, deps)
  }
  deps.recordRun(running, { run }, startedAt)
  const finishedAt = iso(deps)
  if (run.status === 'reviewed') history.setPause(undefined)
  if (run.status === 'skipped') {
    history.updateJob(job.id, { status: 'skipped', reason: run.reason.kind, finishedAt })
  } else if (run.publication?.status === 'failed') {
    return fail(running, run.publication.error, deps.classify(run.publication.error), deps)
  } else if (run.publication?.status === 'superseded') {
    history.updateJob(job.id, { status: 'superseded', finishedAt })
    const pull = history.pulls(job.repo).find((stored) => stored.number === job.number)
    if (pull !== undefined) {
      history.savePull({ ...pull, headSha: run.publication.headSha, headSeenAt: finishedAt })
    }
  } else if (run.publication?.status === 'closed-or-draft') {
    history.updateJob(job.id, { status: 'skipped', reason: 'closed-or-draft', finishedAt })
  } else {
    history.updateJob(job.id, { status: 'done', finishedAt })
  }
  events.finished(running, run)
  return undefined
}

function fail(
  job: JobRecord,
  error: unknown,
  { kind, resetAt }: Failure,
  deps: WatchDeps,
): WatchExit | undefined {
  const { history, events } = deps
  const pause = history.pause()
  const outcome = afterFailure({
    job,
    kind,
    now: iso(deps),
    ...(pause === undefined ? {} : { pause }),
    ...(resetAt === undefined ? {} : { resetAt }),
  })
  history.updateJob(job.id, { ...outcome.job, error: errorMessage(error) })
  if (outcome.pause !== undefined) pauseQueue(deps, outcome.pause)
  if (outcome.stop) return { reason: 'fatal', error }
  if (outcome.job.status === 'failed') events.failed(job, error)
  else if (kind === 'transient' && outcome.job.notBefore !== undefined) {
    events.retry(job, outcome.job.notBefore, error)
  }
  return undefined
}

function pauseQueue(deps: WatchDeps, pause: PauseState): void {
  deps.history.setPause(pause)
  deps.events.paused(pause)
}

async function refreshIdle(
  repo: string,
  settings: WatchSettings,
  branches: Map<string, string | undefined>,
  deps: WatchDeps,
): Promise<void> {
  const { history } = deps
  const record = history.repo(repo) ?? { repo }
  const now = iso(deps)
  if (
    record.branchCheckedAt !== undefined &&
    later(record.branchCheckedAt, settings.intervalMs) > now
  ) {
    return
  }
  try {
    if (!branches.has(repo)) branches.set(repo, await deps.defaultBranch(repo))
    const branch = branches.get(repo)
    if (branch === undefined) return
    const head = await deps.branchHead(repo, branch, record.branchEtag)
    if (head.status === 'not-modified' || head.sha === record.indexedSha) {
      history.saveRepo({
        ...record,
        branchCheckedAt: now,
        ...(head.status === 'ok' && head.etag !== undefined ? { branchEtag: head.etag } : {}),
      })
      return
    }
    const result = await deps.refreshIndex(repo, IDLE_INDEX_BUDGET_MS)
    if (result === 'partial') {
      history.saveRepo({ ...record, branchCheckedAt: now })
      deps.events.indexPartial(repo)
      return
    }
    history.saveRepo({
      ...record,
      branchCheckedAt: now,
      indexedSha: head.sha,
      ...(head.etag === undefined ? {} : { branchEtag: head.etag }),
    })
    deps.events.indexed(repo, head.sha)
  } catch (error) {
    history.saveRepo({ ...record, branchCheckedAt: now })
    deps.events.warning(`${repo}: could not refresh the index (${errorMessage(error)})`)
  }
}

function nextWake(
  settings: WatchSettings,
  history: HistoryStore,
  waitUntil: string | undefined,
): string {
  const candidates = settings.repos.flatMap(({ repo }) => {
    const record = history.repo(repo)
    return [record?.checkedAt, record?.branchCheckedAt].flatMap((at) =>
      at === undefined ? [] : [later(at, settings.intervalMs)],
    )
  })
  if (waitUntil !== undefined) candidates.push(waitUntil)
  return candidates.sort()[0] ?? new Date(0).toISOString()
}

function pauseOf(history: HistoryStore): { pause?: PauseState } {
  const pause = history.pause()
  return pause === undefined ? {} : { pause }
}

function iso(deps: WatchDeps): string {
  return deps.now().toISOString()
}
