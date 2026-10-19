import { durationMs } from './duration.js'
import type { ConfigLayer } from './types.js'

export const DEFAULT_WATCH_INTERVAL_MS = 300_000
export const DEFAULT_SETTLE_MS = 180_000
export const DEFAULT_MAX_REVIEWS_PER_HOUR = 6

export interface WatchedRepoSettings {
  repo: string
  publish: boolean
  allowExternal: boolean
  authors?: string[]
  labels?: string[]
  baseBranches?: string[]
}

export interface WatchSettings {
  intervalMs: number
  settleMs: number
  maxReviewsPerHour: number
  repos: WatchedRepoSettings[]
}

export function resolveWatchSettings(layers: readonly ConfigLayer[]): WatchSettings | undefined {
  const watch = topLevel(layers)?.config.watch
  if (watch === undefined) return undefined
  return {
    intervalMs:
      watch.interval === undefined ? DEFAULT_WATCH_INTERVAL_MS : durationMs(watch.interval),
    settleMs: watch.settle === undefined ? DEFAULT_SETTLE_MS : durationMs(watch.settle),
    maxReviewsPerHour: watch.maxReviewsPerHour ?? DEFAULT_MAX_REVIEWS_PER_HOUR,
    repos: watch.repos.map((entry) => {
      if (typeof entry === 'string') {
        return { repo: entry.toLowerCase(), publish: true, allowExternal: false }
      }
      const { repo, publish, allowExternal, ...filters } = entry
      return {
        repo: repo.toLowerCase(),
        publish: publish ?? true,
        allowExternal: allowExternal ?? false,
        ...filters,
      }
    }),
  }
}

export function historyEnabled(layers: readonly ConfigLayer[]): boolean {
  return topLevel(layers)?.config.history !== false
}

function topLevel(layers: readonly ConfigLayer[]): ConfigLayer | undefined {
  return layers.find((layer) => layer.kind === 'user')
}
