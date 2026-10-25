import { readQueue } from '../app/read-queue.js'
import type { ConfigLayer } from '../config/types.js'
import { resolveWatchSettings } from '../config/watch-settings.js'
import type { HistoryStatus, HistoryStore } from '../store/history-store.js'
import type { IndexFormat } from './args.js'
import { formatWatchStatus, formatWatchStatusJson } from './format-watch.js'

export function watchStatusText(
  history: HistoryStore,
  layers: readonly ConfigLayer[],
  holder: number | undefined,
  now: Date,
  format: IndexFormat,
): string {
  const view = readQueue({ history, settings: resolveWatchSettings(layers), holder, now })
  const status: HistoryStatus = {
    repos: view.repos,
    queued: view.queue.map(({ job }) => job),
    running: view.running.map(({ job }) => job),
    failed: view.failed.map(({ job }) => job),
    lastRuns: view.lastRuns,
    ...(view.pause === null ? {} : { pause: view.pause }),
  }
  const running = view.holder ?? undefined
  const hourly = view.hourly ?? undefined
  return format === 'json'
    ? formatWatchStatusJson(status, running, now, hourly)
    : formatWatchStatus(status, running, now, hourly)
}
