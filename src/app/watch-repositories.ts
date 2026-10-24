import type { WatchedRepoSettings, WatchSettings } from '../config/watch-settings.js'
import type { CommentListing } from '../github/issue-comments.js'
import type { OpenPull, PullListing } from '../github/list-pull-requests.js'
import type { BranchHead } from '../github/repository.js'
import type { DuePull, HistoryStore } from '../store/history-store.js'
import type { PullFacts } from '../watch/request-policy.js'
import type { FailureKind, JobRecord, PauseState, RequestRecord } from '../watch/types.js'
import { afterFailure, MAX_ATTEMPTS, rateLimitPause } from '../watch/failures.js'
import { later } from '../watch/time.js'
import { pickNext, RATE_WINDOW_MS } from '../watch/next-job.js'
import { planCycle } from '../watch/plan-cycle.js'
import { prCommands } from '../watch/pr-commands.js'
import type { CycleAction } from '../watch/plan-cycle.js'
import { errorMessage } from './error-message.js'
import type { ReviewRun } from './review-and-publish.js'
import { submitRequest, whenInput } from './submit-request.js'
import type { ReviewRequestInput, SubmitDeps, SubmitResult, WhenInput } from './submit-request.js'

export const IDLE_INDEX_BUDGET_MS = 60_000
export const FEEDBACK_INTERVAL_MS = 1_800_000
export const FEEDBACK_PULLS_PER_CYCLE = 10

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
  feedback(repo: string, number: number, threads: number): void
  warning(message: string): void
  limited(count: number, until: string): void
  refused(request: ReviewRequestInput, result: SubmitResult & { status: 'refused' }): void
}

export interface JobEvent {
  kind: 'started' | 'finished' | 'failed' | 'skipped'
  job: JobRecord
  requests: readonly RequestRecord[]
  reason?: string
}

export interface WatchDeps {
  history: HistoryStore
  listPulls(repo: string, etag?: string): Promise<PullListing>
  defaultBranch(repo: string): Promise<string | undefined>
  branchHead(repo: string, branch: string, etag?: string): Promise<BranchHead>
  readPull(repo: string, number: number): Promise<PullFacts>
  checkWhen?(command: string, input: WhenInput): Promise<string | undefined>
  listComments?(repo: string, since: string, etag?: string): Promise<CommentListing>
  react?(repo: string, commentId: number): Promise<void>
  runJob(job: JobRecord, requests: readonly RequestRecord[]): Promise<ReviewRun>
  recordRun(job: JobRecord, outcome: RunOutcome, startedAt: string): void
  refreshIndex(repo: string, budgetMs: number): Promise<'complete' | 'partial'>
  refreshFeedback(pulls: readonly DuePull[]): Promise<void>
  notify(event: JobEvent): Promise<void>
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
      const exit = await runJob(next.job, settings, deps)
      if (exit !== undefined) return exit
      continue
    }
    for (const repo of settings.repos) {
      if (deps.stopRequested()) return { reason: 'stopped' }
      await refreshIdle(repo.repo, settings, branches, deps)
    }
    if (deps.stopRequested()) return { reason: 'stopped' }
    await refreshFeedback(settings, deps)
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
  const checkedAt = deps.history.repo(repo.repo)?.checkedAt
  const due =
    always || checkedAt === undefined || later(checkedAt, input.settings.intervalMs) <= iso(deps)
  if (!due) return undefined
  const exit = await discoverPulls(repo, input, deps)
  if (exit === undefined) await scanCommands(repo, input.settings, deps)
  return exit
}

async function discoverPulls(
  repo: WatchedRepoSettings,
  input: WatchInput,
  deps: WatchDeps,
): Promise<WatchExit | undefined> {
  const { history } = deps
  const record = history.repo(repo.repo) ?? { repo: repo.repo }
  const now = iso(deps)
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
  const jobs = history.jobs({ repo: repo.repo })
  const actions = planCycle({
    repo,
    pulls: listing.pulls,
    stored: history.pulls(repo.repo),
    jobs,
    requests: history.requests(
      jobs.filter(({ status }) => status === 'queued').map(({ id }) => id),
    ),
    baselineDone: record.baselineAt !== undefined,
    backfill: input.backfill,
    now,
    settleMs: input.settings.settleMs,
  })
  const ended: JobEvent[] = []
  for (const action of actions) {
    if (action.kind === 'enqueue' && (await refusedByWhen(action.job, repo, listing.pulls, deps))) {
      history.addJob({ ...action.job, status: 'skipped', reason: 'when-command', finishedAt: now })
      continue
    }
    ended.push(...apply(action, repo, now, deps))
  }
  const { pullsEtag: _old, ...rest } = record
  history.saveRepo({
    ...rest,
    ...(listing.etag === undefined ? {} : { pullsEtag: listing.etag }),
    checkedAt: now,
    baselineAt: record.baselineAt ?? now,
  })
  for (const event of ended) {
    if (event.reason === 'superseded') await follow(event.job, input.settings, deps)
    await notifyStaying(event, deps)
  }
  return undefined
}

function apply(
  action: CycleAction,
  repo: WatchedRepoSettings,
  now: string,
  deps: WatchDeps,
): JobEvent[] {
  const { history, events } = deps
  const publish = repo.publish ? ('pr' as const) : ('none' as const)
  switch (action.kind) {
    case 'baseline':
      for (const pull of action.pulls) history.savePull(pull)
      events.baseline(repo.repo, action.pulls.length)
      return []
    case 'seen':
      history.savePull(action.pull)
      return []
    case 'enqueue': {
      const id = history.addJob(action.job)
      history.addRequest({ jobId: id, source: 'watch', publish, createdAt: now })
      events.queued({ ...action.job, id })
      return []
    }
    case 'join':
      history.addRequest({ jobId: action.jobId, source: 'watch', publish, createdAt: now })
      if (publish === 'pr') history.updateJob(action.jobId, { publish })
      return []
    case 'supersede': {
      history.updateJob(action.jobId, { status: 'superseded', finishedAt: now })
      const job = history
        .jobs({ repo: repo.repo, status: ['superseded'] })
        .find((j) => j.id === action.jobId)
      if (job === undefined) return []
      events.superseded(job)
      return [{ kind: 'skipped', job, requests: history.requests([job.id]), reason: 'superseded' }]
    }
    case 'gone': {
      history.savePull(action.pull)
      const gone = history.jobs({ repo: repo.repo }).filter(({ id }) => action.jobIds.includes(id))
      for (const job of gone) {
        history.updateJob(job.id, { status: 'skipped', reason: 'closed', finishedAt: now })
      }
      return gone.map((job) => ({
        kind: 'skipped' as const,
        job: { ...job, status: 'skipped' as const, reason: 'closed', finishedAt: now },
        requests: history.requests([job.id]),
        reason: 'closed',
      }))
    }
  }
}

async function runJob(
  job: JobRecord,
  settings: WatchSettings,
  deps: WatchDeps,
): Promise<WatchExit | undefined> {
  const { history, events } = deps
  const startedAt = iso(deps)
  history.updateJob(job.id, { status: 'running', startedAt })
  const running = { ...job, status: 'running' as const, startedAt }
  const requests = history.requests([job.id])
  events.started(running)
  await deps.notify({ kind: 'started', job: running, requests })
  let run: ReviewRun
  try {
    run = await deps.runJob(running, requests)
  } catch (error) {
    const failure = deps.classify(error)
    deps.recordRun(running, { error, kind: failure.kind }, startedAt)
    return fail(running, requests, error, failure, deps)
  }
  deps.recordRun(running, { run }, startedAt)
  const finishedAt = iso(deps)
  if (run.status === 'reviewed') history.setPause(undefined)
  const ended = { ...running, finishedAt }
  if (run.status === 'skipped') {
    history.updateJob(job.id, { status: 'skipped', reason: run.reason.kind, finishedAt })
    events.finished(running, run)
    await deps.notify({ kind: 'skipped', job: ended, requests, reason: run.reason.kind })
  } else if (run.publication?.status === 'failed') {
    const error = run.publication.error
    return fail(running, requests, error, deps.classify(error), deps)
  } else if (run.publication?.status === 'superseded') {
    history.updateJob(job.id, { status: 'superseded', finishedAt })
    const pull = history.pulls(job.repo).find((stored) => stored.number === job.number)
    if (pull !== undefined) {
      history.savePull({ ...pull, headSha: run.publication.headSha, headSeenAt: finishedAt })
    }
    events.finished(running, run)
    await follow(running, settings, deps)
    await notifyStaying({ kind: 'skipped', job: ended, requests, reason: 'superseded' }, deps)
  } else if (run.publication?.status === 'closed-or-draft') {
    history.updateJob(job.id, { status: 'skipped', reason: 'closed-or-draft', finishedAt })
    events.finished(running, run)
    await deps.notify({ kind: 'skipped', job: ended, requests, reason: 'closed-or-draft' })
  } else {
    history.updateJob(job.id, { status: 'done', finishedAt })
    events.finished(running, run)
    await deps.notify({ kind: 'finished', job: { ...ended, status: 'done' }, requests })
  }
  return undefined
}

async function scanCommands(
  repo: WatchedRepoSettings,
  settings: WatchSettings,
  deps: WatchDeps,
): Promise<void> {
  const { history } = deps
  const record = history.repo(repo.repo)
  if (record?.baselineAt === undefined || deps.listComments === undefined) return
  let listing: CommentListing
  try {
    listing = await deps.listComments(
      repo.repo,
      record.commentsSince ?? record.baselineAt,
      record.commentsEtag,
    )
  } catch (error) {
    deps.events.warning(`${repo.repo}: could not read the comments (${errorMessage(error)})`)
    return
  }
  if (listing.status === 'not-modified') return
  const scan = prCommands(listing.comments, {
    baselineAt: record.baselineAt,
    ...(record.commentsLastId === undefined ? {} : { lastId: record.commentsLastId }),
  })
  history.saveRepo({
    ...record,
    ...(listing.etag === undefined ? {} : { commentsEtag: listing.etag }),
    ...(scan.lastId === undefined ? {} : { commentsLastId: scan.lastId }),
    ...(scan.since === undefined ? {} : { commentsSince: scan.since }),
  })
  for (const command of scan.commands) {
    const request = {
      repo: repo.repo,
      number: command.number,
      source: 'pr-command' as const,
      publish: 'pr' as const,
      data: { commentId: command.commentId, url: command.url, author: command.author },
    }
    try {
      const result = await submitRequest(request, submitDepsOf(settings, deps))
      if (result.status === 'refused') {
        deps.events.refused(request, result)
        continue
      }
      if (result.status === 'queued') deps.events.queued(result.job)
      await deps.react?.(repo.repo, command.commentId)
    } catch (error) {
      deps.events.warning(
        `${repo.repo}#${command.number}: could not take /phada review (${errorMessage(error)})`,
      )
    }
  }
}

function submitDepsOf(settings: WatchSettings, deps: WatchDeps): SubmitDeps {
  return {
    history: deps.history,
    settings,
    readPull: deps.readPull,
    now: deps.now,
    ...(deps.checkWhen === undefined ? {} : { checkWhen: deps.checkWhen }),
  }
}

async function refusedByWhen(
  job: Omit<JobRecord, 'id'>,
  repo: WatchedRepoSettings,
  pulls: readonly OpenPull[],
  deps: WatchDeps,
): Promise<boolean> {
  const listed = pulls.find(({ number }) => number === job.number)
  if (repo.when === undefined || deps.checkWhen === undefined || listed === undefined) return false
  const pull: PullFacts = {
    repo: repo.repo,
    number: listed.number,
    headSha: listed.headSha,
    state: 'open',
    private: listed.private,
    association: listed.association,
    author: listed.author,
    draft: listed.draft,
    baseRef: listed.baseRef,
    labels: listed.labels,
    ...(listed.title === undefined ? {} : { title: listed.title }),
  }
  const refusal = await deps.checkWhen(
    repo.when,
    whenInput(pull, { source: 'watch', publish: job.publish ?? 'pr' }),
  )
  if (refusal === undefined) return false
  deps.events.warning(`${repo.repo}#${job.number}: the when command refused it (${refusal})`)
  return true
}

async function notifyStaying(event: JobEvent, deps: WatchDeps): Promise<void> {
  const requests =
    event.reason === 'superseded'
      ? event.requests.filter(({ source }) => source === 'watch')
      : event.requests
  if (requests.length > 0) await deps.notify({ ...event, requests })
}

async function follow(job: JobRecord, settings: WatchSettings, deps: WatchDeps): Promise<void> {
  const requests = deps.history.requests([job.id]).filter(({ source }) => source !== 'watch')
  for (const request of requests) {
    const { source, publish, data } = request
    try {
      const result = await submitRequest(
        {
          repo: job.repo,
          number: job.number,
          source,
          publish,
          ...(data === undefined ? {} : { data }),
        },
        submitDepsOf(settings, deps),
      )
      if (result.status === 'queued') deps.events.queued(result.job)
      if (result.status === 'refused') {
        const reviewed = result.reason === 'already-reviewed' ? result.job : undefined
        await deps.notify(
          reviewed === undefined
            ? { kind: 'skipped', job, requests: [request], reason: result.reason }
            : {
                kind: reviewed.status === 'done' ? 'finished' : 'skipped',
                job: reviewed,
                requests: [request],
                ...(reviewed.reason === undefined ? {} : { reason: reviewed.reason }),
              },
        )
      }
    } catch (error) {
      deps.events.warning(
        `${job.repo}#${job.number}: could not move a ${source} request to the new commit (${errorMessage(error)})`,
      )
    }
  }
}

async function fail(
  job: JobRecord,
  requests: readonly RequestRecord[],
  error: unknown,
  { kind, resetAt }: Failure,
  deps: WatchDeps,
): Promise<WatchExit | undefined> {
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
  if (outcome.job.status === 'failed') {
    events.failed(job, error)
    await deps.notify({ kind: 'failed', job: { ...job, ...outcome.job }, requests })
  } else if (kind === 'transient' && outcome.job.notBefore !== undefined) {
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

async function refreshFeedback(settings: WatchSettings, deps: WatchDeps): Promise<void> {
  const due = deps.history.feedbackDue(
    { repos: settings.repos.map(({ repo }) => repo) },
    later(iso(deps), -FEEDBACK_INTERVAL_MS),
    FEEDBACK_PULLS_PER_CYCLE,
  )
  if (due.length === 0) return
  try {
    await deps.refreshFeedback(due)
  } catch (error) {
    deps.events.warning(`could not refresh the feedback (${errorMessage(error)})`)
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
