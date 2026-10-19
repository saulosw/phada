import type { ConfigLayer } from '../config/types.js'
import { resolveWatchSettings } from '../config/watch-settings.js'
import type { HistoryStore } from '../store/history-store.js'
import { RATE_WINDOW_MS } from '../watch/next-job.js'
import type { IndexFormat } from './args.js'
import { formatWatchStatus, formatWatchStatusJson } from './format-watch.js'

export function watchStatusText(
  history: HistoryStore,
  layers: readonly ConfigLayer[],
  holder: number | undefined,
  now: Date,
  format: IndexFormat,
): string {
  const status = history.status()
  const running = holder === undefined ? undefined : { pid: holder }
  const max = resolveWatchSettings(layers)?.maxReviewsPerHour
  const since = new Date(now.getTime() - RATE_WINDOW_MS).toISOString()
  const hourly =
    max === undefined ? undefined : { count: history.watchRunsSince(since).length, max }
  return format === 'json'
    ? formatWatchStatusJson(status, running, now, hourly)
    : formatWatchStatus(status, running, now, hourly)
}
