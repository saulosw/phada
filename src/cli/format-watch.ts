import type { ReviewRun } from '../app/review-and-publish.js'
import type { HistoryStatus, RunRecord } from '../store/history-store.js'
import type { JobRecord, PauseState } from '../watch/types.js'
import { errorMessage } from '../app/error-message.js'
import { formatSkipMessage } from './format-publication.js'
import { shortSha } from './review-text.js'
import { toTerminalText } from './terminal-text.js'
import { formatCount } from './units.js'

const SCHEMA_VERSION = 1

export interface HourlyReviews {
  count: number
  max: number
}

export type WatchEventView =
  | { kind: 'baseline'; repo: string; count: number }
  | { kind: 'queued'; job: JobRecord }
  | { kind: 'superseded'; job: JobRecord }
  | { kind: 'started'; job: JobRecord }
  | { kind: 'finished'; job: JobRecord; run: ReviewRun }
  | { kind: 'retry'; job: JobRecord; at: string; error: unknown }
  | { kind: 'paused'; pause: PauseState }
  | { kind: 'failed'; job: JobRecord; error: unknown }
  | { kind: 'indexed'; repo: string; sha: string }
  | { kind: 'indexPartial'; repo: string }
  | { kind: 'feedback'; repo: string; number: number; threads: number }
  | { kind: 'warning'; message: string }
  | { kind: 'limited'; count: number; until: string }

export function formatWatchEvent(event: WatchEventView, at: Date): string {
  return `[${clock(at)}] ${toTerminalText(eventText(event))}`
}

function eventText(event: WatchEventView): string {
  switch (event.kind) {
    case 'baseline':
      return `${event.repo}: ${formatCount(event.count, 'open pull request')} recorded as they are; new pushes will be reviewed.`
    case 'queued':
      return `Queued ${ref(event.job)} at ${shortSha(event.job.headSha)}; review after ${clock(new Date(event.job.notBefore))}.`
    case 'superseded':
      return `${ref(event.job)}: a newer commit replaces ${shortSha(event.job.headSha)}.`
    case 'started':
      return `Reviewing ${ref(event.job)} at ${shortSha(event.job.headSha)}…`
    case 'finished':
      return finishedText(event.job, event.run)
    case 'retry':
      return `${ref(event.job)} failed (${reason(event.error)}); trying again at ${clock(new Date(event.at))}.`
    case 'paused':
      return `Paused until ${clock(new Date(event.pause.until))}: ${pauseReason(event.pause)}.`
    case 'failed':
      return `${ref(event.job)} failed: ${reason(event.error)}. A new commit is reviewed again.`
    case 'indexed':
      return `${event.repo}: index of the default branch updated to ${shortSha(event.sha)}.`
    case 'indexPartial':
      return `${event.repo}: indexing the default branch; it goes on when the queue is idle.`
    case 'feedback':
      return `Feedback: ${event.repo}#${event.number}, ${formatCount(event.threads, 'comment')}.`
    case 'warning':
      return `Warning: ${event.message}`
    case 'limited':
      return `${formatCount(event.count, 'review')} in the last hour (maxReviewsPerHour): the next one starts at ${clock(new Date(event.until))}.`
  }
}

function finishedText(job: JobRecord, run: ReviewRun): string {
  if (run.status === 'skipped') return `${ref(job)}: ${formatSkipMessage(job.headSha, run.reason)}`
  const publication = run.publication
  if (publication === undefined) return `${ref(job)}: nothing to review.`
  switch (publication.status) {
    case 'published':
      return `Published ${ref(job)}: ${publication.url}`
    case 'not-published':
      return `Reviewed ${ref(job)}; kept in the history, not published.`
    case 'superseded':
      return `${ref(job)} moved to ${shortSha(publication.headSha)} during the review; not published.`
    case 'closed-or-draft':
      return `${ref(job)} was closed during the review; not published.`
    case 'dry-run':
      return `Reviewed ${ref(job)}; nothing was posted.`
    case 'failed':
      return `${ref(job)}: publishing failed (${reason(publication.error)}).`
  }
}

export function formatWatchStatus(
  status: HistoryStatus,
  running: { pid: number } | undefined,
  now: Date,
  hourly?: HourlyReviews,
): string {
  const lines = [
    running === undefined ? 'Watch: not running' : `Watch: running (PID ${running.pid})`,
  ]
  const pause = activePause(status.pause, now)
  if (pause !== undefined) lines.push(`Paused until ${when(pause.until)}: ${pauseReason(pause)}.`)
  if (hourly !== undefined) lines.push(`Reviews in the last hour: ${hourly.count} of ${hourly.max}`)
  lines.push('')
  const width = Math.max(0, ...status.repos.map(({ repo }) => repo.length))
  section(lines, 'Repositories', 'none yet', status.repos, (repo) => {
    const name = repo.repo.padEnd(width)
    if (repo.checkedAt === undefined) return `${name}  not checked yet`
    const index = repo.indexedSha === undefined ? '' : ` · index at ${shortSha(repo.indexedSha)}`
    return `${name}  checked ${when(repo.checkedAt)}${index}`
  })
  section(lines, 'Queue', 'empty', status.queued, (job) => {
    const attempt = job.attempts === 0 ? '' : ` · attempt ${job.attempts + 1}`
    return `${jobLabel(job)}  after ${when(job.notBefore)}${attempt}`
  })
  section(lines, 'In progress', 'none', status.running, (job) =>
    job.startedAt === undefined ? jobLabel(job) : `${jobLabel(job)}  since ${when(job.startedAt)}`,
  )
  section(lines, 'Failed', 'none', status.failed, (job) =>
    [jobLabel(job), job.finishedAt === undefined ? '' : when(job.finishedAt), job.error ?? '']
      .filter((part) => part !== '')
      .join('  '),
  )
  section(lines, 'Last reviews', 'none', status.lastRuns, (run) => runLine(run))
  if (lines.at(-1) !== '') lines.push('')
  return lines.map((line) => toTerminalText(line)).join('\n')
}

export function formatWatchStatusJson(
  status: HistoryStatus,
  running: { pid: number } | undefined,
  now: Date,
  hourly?: HourlyReviews,
): string {
  const body = {
    schemaVersion: SCHEMA_VERSION,
    running: running ?? null,
    pause: activePause(status.pause, now) ?? null,
    reviewsLastHour: hourly ?? null,
    repos: status.repos.map(({ repo, baselineAt, checkedAt, branchCheckedAt, indexedSha }) => ({
      repo,
      ...(baselineAt === undefined ? {} : { baselineAt }),
      ...(checkedAt === undefined ? {} : { checkedAt }),
      ...(branchCheckedAt === undefined ? {} : { branchCheckedAt }),
      ...(indexedSha === undefined ? {} : { indexedSha }),
    })),
    queue: status.queued,
    inProgress: status.running,
    failed: status.failed,
    lastRuns: status.lastRuns,
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

function section<T>(
  lines: string[],
  title: string,
  empty: string,
  items: readonly T[],
  line: (item: T) => string,
): void {
  if (items.length === 0) {
    lines.push(`${title}: ${empty}`)
    return
  }
  if (lines.at(-1) !== '') lines.push('')
  lines.push(`${title}:`, ...items.map((item) => `  ${line(item)}`), '')
}

function runLine(run: RunRecord): string {
  const parts = [
    `${run.repo}#${run.number}`,
    shortSha(run.headSha),
    `${run.status} ${when(run.finishedAt)}`,
    run.url ?? run.error ?? run.reason ?? '',
  ]
  return parts.filter((part) => part !== '').join('  ')
}

function activePause(pause: PauseState | undefined, now: Date): PauseState | undefined {
  return pause !== undefined && Date.parse(pause.until) > now.getTime() ? pause : undefined
}

function pauseReason(pause: PauseState): string {
  return pause.reason === 'rate-limit' ? 'the GitHub rate limit' : "the AI provider's usage limit"
}

function ref(job: JobRecord): string {
  return `${job.repo}#${job.number}`
}

function jobLabel(job: JobRecord): string {
  return `${ref(job)}  ${shortSha(job.headSha)}`
}

function clock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function when(iso: string): string {
  const date = new Date(iso)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock(date)}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function reason(error: unknown): string {
  return errorMessage(error).replace(/\.$/, '')
}
