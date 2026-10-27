import type { WatchSettings } from '../config/watch-settings.js'
import type { HistoryStore, RepoRecord, RunRecord, StatusJob } from '../store/history-store.js'
import { revisitsCi } from '../watch/ci-revisit.js'
import { RATE_WINDOW_MS } from '../watch/next-job.js'
import type { JobRecord, PauseState, RequestRecord } from '../watch/types.js'

export type QueueHistory = Pick<HistoryStore, 'status' | 'jobs' | 'requests' | 'watchRunsSince'>

export interface QueueJob {
  job: StatusJob
  requests: RequestRecord[]
}

export interface QueueView {
  recorded: boolean
  watchConfigured: boolean
  configFile: string
  holder: { pid: number } | null
  pause: PauseState | null
  hourly: { count: number; max: number } | null
  repos: RepoRecord[]
  lastCycleAt: string | null
  nextCycle: { at: string; estimated: true } | null
  queue: QueueJob[]
  running: QueueJob[]
  skippedForCi: QueueJob[]
  failed: QueueJob[]
  lastRuns: RunRecord[]
}

export function readQueue(input: {
  history: QueueHistory | undefined
  settings: WatchSettings | undefined
  holder: number | undefined
  now: Date
  configFile: string
}): QueueView {
  const { history, settings, holder, now, configFile } = input
  const status = history?.status() ?? {
    repos: [],
    queued: [],
    running: [],
    failed: [],
    lastRuns: [],
  }
  const skipped = (history?.jobs({ status: ['skipped'] }) ?? []).filter((job) =>
    revisitsCi(job, now.toISOString()),
  )
  const shown: JobRecord[] = [...status.queued, ...status.running, ...skipped, ...status.failed]
  const requests = history?.requests(shown.map(({ id }) => id)) ?? []
  const withRequests = (jobs: readonly StatusJob[]): QueueJob[] =>
    jobs.map((job) => ({ job, requests: requests.filter(({ jobId }) => jobId === job.id) }))
  const since = new Date(now.getTime() - RATE_WINDOW_MS).toISOString()
  const lastCycleAt = latest(status.repos.map(({ checkedAt }) => checkedAt))
  return {
    recorded: history !== undefined,
    watchConfigured: settings !== undefined,
    configFile,
    holder: holder === undefined ? null : { pid: holder },
    pause: activePause(status.pause, now),
    hourly:
      settings === undefined
        ? null
        : {
            count: history?.watchRunsSince(since).length ?? 0,
            max: settings.maxReviewsPerHour,
          },
    repos: status.repos,
    lastCycleAt,
    nextCycle:
      holder === undefined || settings === undefined || lastCycleAt === null
        ? null
        : {
            at: new Date(Date.parse(lastCycleAt) + settings.intervalMs).toISOString(),
            estimated: true,
          },
    queue: withRequests(status.queued),
    running: withRequests(status.running),
    skippedForCi: withRequests(skipped),
    failed: withRequests(status.failed),
    lastRuns: status.lastRuns,
  }
}

function latest(times: readonly (string | undefined)[]): string | null {
  return times.reduce<string | null>(
    (last, time) => (time !== undefined && (last === null || time > last) ? time : last),
    null,
  )
}

function activePause(pause: PauseState | undefined, now: Date): PauseState | null {
  return pause !== undefined && Date.parse(pause.until) > now.getTime() ? pause : null
}
