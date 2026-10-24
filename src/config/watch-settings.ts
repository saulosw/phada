import { durationMs } from './duration.js'
import type { ReviewEventName } from './schema.js'
import type { ConfigLayer } from './types.js'

export const DEFAULT_WATCH_INTERVAL_MS = 300_000
export const DEFAULT_SETTLE_MS = 180_000
export const DEFAULT_MAX_REVIEWS_PER_HOUR = 6
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000

export interface WatchedRepoSettings {
  repo: string
  publish: boolean
  allowExternal: boolean
  authors?: string[]
  labels?: string[]
  baseBranches?: string[]
  when?: string
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
      const fallback = watch.when === undefined ? {} : { when: watch.when.command }
      if (typeof entry === 'string') {
        return { repo: entry.toLowerCase(), publish: true, allowExternal: false, ...fallback }
      }
      const { repo, publish, allowExternal, when, ...filters } = entry
      return {
        repo: repo.toLowerCase(),
        publish: publish ?? true,
        allowExternal: allowExternal ?? false,
        ...filters,
        ...(when === undefined ? fallback : { when: when.command }),
      }
    }),
  }
}

export interface HookSettings {
  commands: Partial<Record<ReviewEventName, string>>
  timeoutMs: number
  cwd: string
}

export function resolveHookSettings(layers: readonly ConfigLayer[]): HookSettings | undefined {
  const layer = topLevel(layers)
  const hooks = layer?.config.hooks
  if (layer === undefined || hooks === undefined) return undefined
  const { timeout, ...commands } = hooks
  return {
    commands,
    timeoutMs: timeout === undefined ? DEFAULT_HOOK_TIMEOUT_MS : durationMs(timeout),
    cwd: layer.dir,
  }
}

export type SlackReply = 'link' | 'summary' | 'full'
export type SlackEmojis = Record<
  'queued' | 'clean' | 'comments' | 'blocking' | 'failed' | 'skipped',
  string
>

export interface SlackChannelSettings {
  id: string
  publish: 'pr' | 'none'
  reply: SlackReply
}

export interface SlackSettings {
  channels: SlackChannelSettings[]
  emojis: SlackEmojis
}

export const DEFAULT_SLACK_EMOJIS: SlackEmojis = {
  queued: 'hourglass_flowing_sand',
  clean: 'white_check_mark',
  comments: 'speech_balloon',
  blocking: 'x',
  failed: 'warning',
  skipped: 'eyes',
}

export function resolveSlackSettings(layers: readonly ConfigLayer[]): SlackSettings | undefined {
  const slack = topLevel(layers)?.config.slack
  if (slack === undefined) return undefined
  return {
    channels: slack.channels.map(({ id, publish, reply }) => ({
      id,
      publish: publish ?? 'pr',
      reply: reply ?? 'link',
    })),
    emojis: { ...DEFAULT_SLACK_EMOJIS, ...slack.emojis },
  }
}

export function historyEnabled(layers: readonly ConfigLayer[]): boolean {
  return topLevel(layers)?.config.history !== false
}

function topLevel(layers: readonly ConfigLayer[]): ConfigLayer | undefined {
  return layers.find((layer) => layer.kind === 'user')
}
