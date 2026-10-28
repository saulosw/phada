import type { ReviewRun } from '../app/review-and-publish.js'
import type { WatchEnd, WatchEvent } from '../app/watch-event.js'
import { failedText } from './data-view.js'
import type { UiMessages } from './i18n/messages.js'
import { refusalText } from './refusal-text.js'
import { clockTime } from './relative-time.js'
import { namesText, oneLine } from './text-fit.js'
import { pullRef, shortSha } from './refs.js'

export type WatchLogLine =
  | { kind: 'event'; event: WatchEvent }
  | { kind: 'watchStarted' }
  | { kind: 'watchStopping' }
  | { kind: 'watchEnded'; end: WatchEnd }

export interface WatchLogEntry {
  at: number
  line: WatchLogLine
}

export type WatchLogTone = 'ok' | 'warn' | 'error' | undefined

export const MAX_LOG_LINES = 200

const NAMES_SHOWN = 3

type Job = Extract<WatchEvent, { kind: 'started' }>['job']

export function appendLog(
  log: readonly WatchLogEntry[],
  entry: WatchLogEntry,
): readonly WatchLogEntry[] {
  return [...log, entry].slice(-MAX_LOG_LINES)
}

export function watchLogTone({ line }: WatchLogEntry): WatchLogTone {
  if (line.kind === 'watchEnded') return line.end.reason === 'fatal' ? 'error' : undefined
  if (line.kind !== 'event') return undefined
  const { event } = line
  switch (event.kind) {
    case 'failed':
      return 'error'
    case 'warning':
    case 'retry':
    case 'paused':
    case 'ciFailing':
    case 'limited':
    case 'refused':
      return 'warn'
    case 'finished':
      return event.run.status !== 'skipped' && event.run.publication?.status === 'published'
        ? 'ok'
        : event.run.status !== 'skipped' && event.run.publication?.status === 'failed'
          ? 'error'
          : undefined
    default:
      return undefined
  }
}

export function watchLogText({ at, line }: WatchLogEntry, messages: UiMessages): string {
  return `${clockTime(at)} ${lineText(line, messages)}`
}

function lineText(line: WatchLogLine, messages: UiMessages): string {
  const l = messages.queue.log
  switch (line.kind) {
    case 'watchStarted':
      return l.watchStarted
    case 'watchStopping':
      return l.watchStopping
    case 'watchEnded':
      return line.end.reason === 'aborted'
        ? l.watchAborted
        : line.end.reason === 'fatal'
          ? failedText(messages, line.end.error, l.watchFailed)
          : l.watchStopped
    case 'event':
      return eventText(line.event, messages)
  }
}

function eventText(event: WatchEvent, messages: UiMessages): string {
  const l = messages.queue.log
  const q = messages.queue
  switch (event.kind) {
    case 'baseline':
      return l.baseline(oneLine(event.repo), event.count)
    case 'queued':
      return l.queued(ref(event.job), shortSha(event.job.headSha), time(event.job.notBefore))
    case 'superseded':
      return l.superseded(ref(event.job), shortSha(event.job.headSha))
    case 'started':
      return l.started(ref(event.job), shortSha(event.job.headSha))
    case 'waiting': {
      const pending = event.job.ciPending ?? []
      return l.waiting(
        ref(event.job),
        shortSha(event.job.headSha),
        time(event.job.ciDeadline ?? event.job.notBefore),
        pending.length === 0 ? q.noChecks : q.pending(pending.length, names(pending)),
      )
    }
    case 'ciFailing':
      return l.ciFailing(
        ref(event.job),
        shortSha(event.job.headSha),
        names(event.job.ciFailing ?? []),
      )
    case 'ciCleared':
      return l.ciCleared(ref(event.job), shortSha(event.job.headSha))
    case 'finished':
      return finishedText(event.job, event.run, messages)
    case 'retry':
      return failedText(messages, event.error, (why) =>
        l.retry(ref(event.job), why, time(event.at)),
      )
    case 'paused':
      return l.paused(
        time(event.pause.until),
        event.pause.reason === 'rate-limit' ? q.pauseReasons.rateLimit : q.pauseReasons.usageLimit,
      )
    case 'failed':
      return failedText(messages, event.error, (why) => l.failed(ref(event.job), why))
    case 'indexed':
      return l.indexed(oneLine(event.repo), shortSha(event.sha))
    case 'indexPartial':
      return l.indexPartial(oneLine(event.repo))
    case 'feedback':
      return l.feedback(pullRef(event.repo, event.number), event.threads)
    case 'warning':
      return l.warning(oneLine(event.message))
    case 'limited':
      return l.limited(event.count, time(event.until))
    case 'refused':
      return l.refused(
        messages.requests.sources[event.request.source],
        pullRef(event.request.repo, event.request.number),
        refusalText(event.result, messages),
      )
  }
}

function finishedText(job: Job, run: ReviewRun, messages: UiMessages): string {
  const l = messages.queue.log
  if (run.status === 'skipped') {
    return l.skipped(
      ref(job),
      messages.reviews.detail.skipReasons[run.reason.kind] ?? oneLine(run.reason.kind),
    )
  }
  const publication = run.publication
  if (publication === undefined) return l.nothingToReview(ref(job))
  switch (publication.status) {
    case 'published':
      return l.published(ref(job), oneLine(publication.url))
    case 'not-published':
      return l.notPublished(ref(job))
    case 'superseded':
      return l.moved(ref(job), shortSha(publication.headSha))
    case 'closed-or-draft':
      return l.closed(ref(job))
    case 'dry-run':
      return l.dryRun(ref(job))
    case 'failed':
      return failedText(messages, publication.error, (why) => l.publishFailed(ref(job), why))
  }
}

function ref(job: Job): string {
  return pullRef(job.repo, job.number)
}

function time(at: string): string {
  const parsed = Date.parse(at)
  return Number.isNaN(parsed) ? oneLine(at) : clockTime(parsed)
}

function names(values: readonly string[]): string {
  return namesText(values, NAMES_SHOWN)
}
