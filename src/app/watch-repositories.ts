import type { WatchedRepoSettings, WatchSettings } from '../config/watch-settings.js'
import type { CommentListing } from '../github/issue-comments.js'
import type { ReviewCommentListing } from '../github/review-comments.js'
import type { RepliesMode } from '../publish/reply-candidates.js'
import type { OpenPull, PullListing } from '../github/list-pull-requests.js'
import type { BranchHead } from '../github/repository.js'
import type { CiState } from '../context/types.js'
import type { CiCheckState } from '../review/types.js'
import type { DuePull, HistoryStore, RepoRecord } from '../store/history-store.js'
import { listedPullFacts } from '../watch/pull-facts.js'
import type { FailureKind, JobRecord, PauseState, RequestRecord } from '../watch/types.js'
import { afterFailure, MAX_ATTEMPTS, rateLimitPause } from '../watch/failures.js'
import { afterRun } from '../watch/after-run.js'
import { later } from '../watch/time.js'
import { CI_PENDING, ciGate } from '../watch/ci-gate.js'
import type { CiFailurePolicy, CiGateSummary } from '../watch/ci-gate.js'
import { CI_FAILING, ciRevisits, requeueForCi, revisitsCi } from '../watch/ci-revisit.js'
import { NOT_STARTED, notStarted, pickNext, RATE_WINDOW_MS } from '../watch/next-job.js'
import { planCycle } from '../watch/plan-cycle.js'
import type { CommentCursor, CursorMove } from '../watch/comment-cursor.js'
import { prCommands } from '../watch/pr-commands.js'
import { replyScan } from '../watch/reply-scan.js'
import type { CycleAction } from '../watch/plan-cycle.js'
import { errorMessage } from './error-message.js'
import { CiReadError } from './read-ci.js'
import type { ThreadReply } from './reply-to-threads.js'
import type { ReviewRun } from './review-and-publish.js'
import { submitRequest, whenInput } from './submit-request.js'
import type { ReviewRequestInput, SubmitDeps, SubmitResult } from './submit-request.js'

export const IDLE_INDEX_BUDGET_MS = 60_000
export const FEEDBACK_INTERVAL_MS = 1_800_000
export const FEEDBACK_PULLS_PER_CYCLE = 10
export const REPLY_THREADS_PER_CYCLE = 10

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

export interface PullCi {
  waitMs: number
  onFailure: CiFailurePolicy
  summary: CiGateSummary
  checks: readonly { name: string; state: CiCheckState }[]
}

export interface JobCi {
  state: CiState
  checks: readonly { name: string; state: CiCheckState }[]
}

export interface WatchReplies {
  threads: readonly ThreadReply[]
  limited: boolean
  more?: true
  unanswered?: number
}

export interface ReplyOptions {
  mode: RepliesMode
  maxThreads: number
}

export type RunOutcome =
  { run: ReviewRun } | { error: unknown; kind: FailureKind } | { skippedForCi: PullCi }

export interface WatchEvents {
  cycle(repo: string, pulls: number): void
  baseline(repo: string, count: number): void
  queued(job: JobRecord): void
  superseded(job: JobRecord): void
  started(job: JobRecord): void
  waiting(job: JobRecord): void
  ciFailing(job: JobRecord): void
  ciCleared(job: JobRecord): void
  finished(job: JobRecord, run: ReviewRun): void
  retry(job: JobRecord, at: string, error: unknown): void
  paused(pause: PauseState): void
  failed(job: JobRecord, error: unknown): void
  indexed(repo: string, sha: string): void
  indexPartial(repo: string): void
  feedback(repo: string, number: number, threads: number, misses: number): void
  warning(message: string): void
  limited(count: number, until: string): void
  refused(request: ReviewRequestInput, result: SubmitResult & { status: 'refused' }): void
  replied(repo: string, number: number, reply: ThreadReply): void
}

export interface JobEvent {
  kind: 'started' | 'finished' | 'failed' | 'skipped'
  job: JobRecord
  requests: readonly RequestRecord[]
  reason?: string
  ci?: JobCi
}

export interface WatchDeps {
  history: HistoryStore
  listPulls(repo: string, etag?: string): Promise<PullListing>
  defaultBranch(repo: string): Promise<string | undefined>
  branchHead(repo: string, branch: string, etag?: string): Promise<BranchHead>
  submit: SubmitDeps
  listComments?(repo: string, since: string, etag?: string): Promise<CommentListing>
  react?(repo: string, commentId: number): Promise<void>
  listReviewComments?(repo: string, since: string, etag?: string): Promise<ReviewCommentListing>
  replyTo?(
    repo: string,
    number: number,
    options: ReplyOptions,
    replied: (reply: ThreadReply) => void,
  ): Promise<WatchReplies>
  readCi?(job: JobRecord): Promise<PullCi | undefined>
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
    const replies = { left: REPLY_THREADS_PER_CYCLE }
    for (const repo of settings.repos) {
      if (deps.stopRequested()) return { reason: 'stopped' }
      const exit = await discover(repo, input, deps, input.once && firstPass, replies)
      if (exit !== undefined) return exit
    }
    firstPass = false
    if (deps.stopRequested()) return { reason: 'stopped' }
    const now = iso(deps)
    const watchRunsLastHour = history.watchRunsSince(later(now, -RATE_WINDOW_MS))
    const next = pickNext({
      queued: history.jobs({ status: NOT_STARTED }),
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
      const passed = await passCiGate(next.job, deps)
      if (passed === undefined) continue
      const exit = await runJob(next.job, settings, deps, passed)
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
  replies: ReplyBudget,
): Promise<WatchExit | undefined> {
  const checkedAt = deps.history.repo(repo.repo)?.checkedAt
  const due =
    always || checkedAt === undefined || later(checkedAt, input.settings.intervalMs) <= iso(deps)
  if (!due) return undefined
  const exit = await discoverPulls(repo, input, deps)
  if (exit !== undefined) return exit
  await scanCommands(repo, input.settings, deps)
  await answerReplies(repo, input.settings, deps, replies)
  await revisitCi(repo.repo, deps)
  return undefined
}

interface ReplyBudget {
  left: number
}

async function answerReplies(
  repo: WatchedRepoSettings,
  settings: WatchSettings,
  deps: WatchDeps,
  budget: ReplyBudget,
): Promise<void> {
  const { listReviewComments, replyTo } = deps
  if (repo.replies === 'off' || listReviewComments === undefined || replyTo === undefined) return
  const pause = deps.history.pause()
  if (pause !== undefined && pause.until > iso(deps)) return
  const open = new Set(
    deps.history
      .pulls(repo.repo)
      .filter(({ state }) => state === 'open')
      .map(({ number }) => number),
  )
  const published = new Set(deps.history.publishedPulls(repo.repo))
  const withThreads = new Set([...open].filter((number) => published.has(number)))
  await scanSince(
    repo.repo,
    REVIEW_COMMENTS,
    listReviewComments,
    (comments, cursor) => {
      const scan = replyScan(comments, { ...cursor, open: withThreads })
      deps.history.markRepliesDue(repo.repo, scan.numbers, iso(deps))
      return scan
    },
    deps,
  )
  await replyToDue(repo, open, settings, deps, budget)
}

async function replyToDue(
  repo: WatchedRepoSettings,
  open: ReadonlySet<number>,
  settings: WatchSettings,
  deps: WatchDeps,
  budget: ReplyBudget,
): Promise<void> {
  const { history, replyTo } = deps
  if (replyTo === undefined) return
  const now = iso(deps)
  for (const due of history.repliesDue(repo.repo)) {
    if (budget.left <= 0 || deps.stopRequested()) return
    if (!open.has(due.number)) {
      history.clearReplyDue(repo.repo, due.number)
      continue
    }
    if (due.triedAt !== undefined && later(due.triedAt, settings.intervalMs) > now) continue
    let run: WatchReplies
    try {
      run = await replyTo(
        repo.repo,
        due.number,
        { mode: repo.replies, maxThreads: budget.left },
        (reply) => deps.events.replied(repo.repo, due.number, reply),
      )
    } catch (error) {
      history.triedReplyDue(repo.repo, due.number, now)
      const { kind, resetAt } = deps.classify(error)
      if (kind === 'rate-limit') {
        pauseQueue(deps, rateLimitPause(now, resetAt))
        budget.left = 0
        return
      }
      deps.events.warning(
        `${repo.repo}#${due.number}: could not answer the replies (${errorMessage(error)}); tried again in the next cycle.`,
      )
      continue
    }
    budget.left -= run.threads.length + (run.unanswered ?? 0)
    if (run.limited) {
      budget.left = 0
      return
    }
    if (run.unanswered !== undefined) history.triedReplyDue(repo.repo, due.number, now)
    else if (run.more === undefined) history.clearReplyDue(repo.repo, due.number)
  }
}

async function revisitCi(repo: string, deps: WatchDeps): Promise<void> {
  const { history, readCi } = deps
  if (readCi === undefined) return
  const now = iso(deps)
  const skipped = history.jobs({ repo, status: ['skipped'] }).filter((job) => revisitsCi(job, now))
  const jobs = ciRevisits({
    jobs: skipped,
    pulls: history.pulls(repo),
    requests: history.requests(skipped.map(({ id }) => id)),
    now,
  })
  for (const job of jobs) {
    if (deps.stopRequested()) return
    let ci: PullCi | undefined
    try {
      ci = await readCi(job)
    } catch (error) {
      deps.events.warning(
        `${repo}#${job.number}: the checks were not read again (${errorMessage(error)})`,
      )
      history.updateJob(job.id, { ciCheckedAt: now })
      continue
    }
    if (ci !== undefined && gateOf(job, ci, now).action === 'skip') {
      history.updateJob(job.id, { ciCheckedAt: now, ciFailing: [...ci.summary.failing] })
      continue
    }
    const queued = requeueForCi(now)
    history.updateJob(job.id, queued)
    deps.events.ciCleared({ ...job, ...queued })
  }
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
    requests: history.requests(jobs.filter(notStarted).map(({ id }) => id)),
    baselineDone: record.baselineAt !== undefined,
    backfill: input.backfill,
    now,
    settleMs: input.settings.settleMs,
  })
  const ended: JobEvent[] = []
  const moved: JobRecord[] = []
  for (const action of actions) {
    if (action.kind === 'enqueue' && (await refusedByWhen(action.job, repo, listing.pulls, deps))) {
      history.addJob({ ...action.job, status: 'skipped', reason: 'when-command', finishedAt: now })
      continue
    }
    if (action.kind === 'move') {
      const job = jobs.find(({ id }) => id === action.jobId)
      if (job !== undefined) moved.push(job)
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
  for (const job of moved) await follow(job, input.settings, deps)
  return undefined
}

function apply(
  action: Exclude<CycleAction, { kind: 'move' }>,
  repo: WatchedRepoSettings,
  now: string,
  deps: WatchDeps,
): JobEvent[] {
  const { history, events } = deps
  const { publish } = repo
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

type JobStartUpdate = Partial<Pick<JobRecord, 'reason' | 'ciPending'>>

interface GatePassed {
  start: JobStartUpdate
  ci?: JobCi
}

async function passCiGate(job: JobRecord, deps: WatchDeps): Promise<GatePassed | undefined> {
  const start: JobStartUpdate = {
    ...(job.reason === CI_PENDING ? { reason: undefined } : {}),
    ...(job.ciPending === undefined ? {} : { ciPending: undefined }),
  }
  if (deps.readCi === undefined) return { start }
  let ci: PullCi | undefined
  try {
    ci = await deps.readCi(job)
  } catch (error) {
    const unread =
      error instanceof CiReadError
        ? error.warnings.join('; ')
        : `the checks were not read (${errorMessage(error)})`
    deps.events.warning(`${job.repo}#${job.number}: ${unread}; reviewing without waiting for CI`)
    return { start }
  }
  if (ci === undefined) return { start }
  const now = iso(deps)
  const gate = gateOf(job, ci, now)
  if (gate.action === 'skip') {
    await skipForCi(job, ci, gate.failing, now, deps)
    return undefined
  }
  if (gate.action !== 'wait') {
    const startCi: JobCi = {
      state: ci.summary.state,
      checks: ci.checks.map(({ name, state }) => ({ name, state })),
    }
    return {
      start: gate.pending === undefined ? start : { ...start, ciPending: gate.pending },
      ci: startCi,
    }
  }
  const waiting = {
    status: 'waiting' as const,
    reason: CI_PENDING,
    notBefore: gate.until,
    ciDeadline: gate.deadline,
    ciPending: gate.pending,
  }
  deps.history.updateJob(job.id, waiting)
  if (job.status !== 'waiting') deps.events.waiting({ ...job, ...waiting })
  return undefined
}

function gateOf(job: JobRecord, ci: PullCi, now: string) {
  return ciGate({
    ci: ci.summary,
    waitMs: ci.waitMs,
    onFailure: ci.onFailure,
    seenAt: job.ciSince ?? job.createdAt,
    now,
  })
}

async function skipForCi(
  job: JobRecord,
  ci: PullCi,
  failing: string[],
  now: string,
  deps: WatchDeps,
): Promise<void> {
  const { history } = deps
  const skipped = {
    status: 'skipped' as const,
    reason: CI_FAILING,
    finishedAt: now,
    ciFailing: failing,
    ciPending: undefined,
    ciCheckedAt: now,
  }
  history.updateJob(job.id, skipped)
  const ended: JobRecord = { ...job, ...skipped }
  deps.recordRun(ended, { skippedForCi: ci }, now)
  deps.events.ciFailing(ended)
  const since = job.ciSince
  const requests = history
    .requests([job.id])
    .filter(({ createdAt }) => since === undefined || createdAt >= since)
  if (requests.length > 0) {
    await deps.notify({ kind: 'skipped', job: ended, requests, reason: CI_FAILING })
  }
}

async function runJob(
  job: JobRecord,
  settings: WatchSettings,
  deps: WatchDeps,
  { start, ci }: GatePassed,
): Promise<WatchExit | undefined> {
  const { history, events } = deps
  const startedAt = iso(deps)
  history.updateJob(job.id, { ...start, status: 'running', startedAt })
  const running = { ...job, ...start, status: 'running' as const, startedAt }
  const requests = history.requests([job.id])
  events.started(running)
  await deps.notify({
    kind: 'started',
    job: running,
    requests,
    ...(ci === undefined ? {} : { ci }),
  })
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
  const after = afterRun(running, run, finishedAt)
  if (after.clearPause) history.setPause(undefined)
  if ('failed' in after)
    return fail(running, requests, after.failed, deps.classify(after.failed), deps)
  history.updateJob(job.id, after.job)
  if (after.pullHead !== undefined) movePullHead(job, after.pullHead, finishedAt, deps)
  events.finished(running, run)
  const event: JobEvent = { ...after.notice, requests }
  if (after.follow) {
    await follow(running, settings, deps)
    await notifyStaying(event, deps)
  } else {
    await deps.notify(event)
  }
  return undefined
}

function movePullHead(job: JobRecord, headSha: string, seenAt: string, deps: WatchDeps): void {
  const pull = deps.history.pulls(job.repo).find((stored) => stored.number === job.number)
  if (pull !== undefined) deps.history.savePull({ ...pull, headSha, headSeenAt: seenAt })
}

async function scanCommands(
  repo: WatchedRepoSettings,
  settings: WatchSettings,
  deps: WatchDeps,
): Promise<void> {
  if (deps.listComments === undefined) return
  const scan = await scanSince(repo.repo, COMMENTS, deps.listComments, prCommands, deps)
  if (scan === undefined) return
  for (const command of scan.commands) {
    const request = {
      repo: repo.repo,
      number: command.number,
      source: 'pr-command' as const,
      publish: 'pr' as const,
      data: { commentId: command.commentId, url: command.url, author: command.author },
    }
    try {
      const result = await submitRequest(request, deps.submit)
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

interface CommentStream {
  label: string
  since: 'commentsSince' | 'reviewCommentsSince'
  etag: 'commentsEtag' | 'reviewCommentsEtag'
  lastId: 'commentsLastId' | 'reviewCommentsLastId'
}

const COMMENTS: CommentStream = {
  label: 'comments',
  since: 'commentsSince',
  etag: 'commentsEtag',
  lastId: 'commentsLastId',
}

const REVIEW_COMMENTS: CommentStream = {
  label: 'review comments',
  since: 'reviewCommentsSince',
  etag: 'reviewCommentsEtag',
  lastId: 'reviewCommentsLastId',
}

type ListingOf<C> = { status: 'not-modified' } | { status: 'ok'; etag?: string; comments: C[] }

async function scanSince<C, S extends CursorMove>(
  repo: string,
  stream: CommentStream,
  list: (repo: string, since: string, etag?: string) => Promise<ListingOf<C>>,
  take: (comments: readonly C[], cursor: CommentCursor) => S,
  deps: WatchDeps,
): Promise<S | undefined> {
  const { history } = deps
  const record = history.repo(repo)
  if (record?.baselineAt === undefined) return undefined
  let listing: ListingOf<C>
  try {
    listing = await list(repo, record[stream.since] ?? record.baselineAt, record[stream.etag])
  } catch (error) {
    deps.events.warning(`${repo}: could not read the ${stream.label} (${errorMessage(error)})`)
    return undefined
  }
  if (listing.status === 'not-modified') return undefined
  const lastId = record[stream.lastId]
  const scan = take(listing.comments, {
    baselineAt: record.baselineAt,
    ...(lastId === undefined ? {} : { lastId }),
  })
  const saved: RepoRecord = { ...record }
  if (listing.etag !== undefined) saved[stream.etag] = listing.etag
  if (scan.lastId !== undefined) saved[stream.lastId] = scan.lastId
  if (scan.since !== undefined) saved[stream.since] = scan.since
  history.saveRepo(saved)
  return scan
}

async function refusedByWhen(
  job: Omit<JobRecord, 'id'>,
  repo: WatchedRepoSettings,
  pulls: readonly OpenPull[],
  deps: WatchDeps,
): Promise<boolean> {
  const listed = pulls.find(({ number }) => number === job.number)
  const { checkWhen } = deps.submit
  if (repo.when === undefined || checkWhen === undefined || listed === undefined) return false
  const pull = listedPullFacts(repo.repo, listed)
  const refusal = await checkWhen(
    repo.when,
    whenInput(pull, { source: 'watch', publish: job.publish ?? repo.publish }),
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
        deps.submit,
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
