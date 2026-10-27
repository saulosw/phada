import { REVIEW_EVENTS } from '../config/schema.js'
import type { ReviewEventName } from '../config/schema.js'
import type { ConfigLayer } from '../config/types.js'
import {
  resolveHookSettings,
  resolveSlackSettings,
  resolveWatchSettings,
} from '../config/watch-settings.js'
import type { SlackChannelSettings } from '../config/watch-settings.js'
import { errorMessage } from './error-message.js'
import { userSettings } from './read-repositories.js'
import type { ConfigSetting } from './read-repositories.js'

export interface SlackToken {
  variable: string
  set: boolean
}

export interface SlackTokens {
  bot: SlackToken
  app: SlackToken
}

export interface AutomationReaders {
  configFile: string
  topLevelLayers(): Promise<ConfigLayer[]>
  slackTokens(): SlackTokens
}

export interface AutomationView {
  configFile: string
  configured: boolean
  configError: string | null
  watch: { intervalMs: number; settleMs: number; maxReviewsPerHour: number; repos: string[] } | null
  ci: ConfigSetting[]
  sources: {
    prComments: boolean
    enqueue: boolean
    mcp: boolean
    slack: { channels: SlackChannelSettings[]; tokens: SlackTokens } | null
  }
  hooks: { events: { event: ReviewEventName; command: string | null }[]; timeoutMs: number } | null
  when: { global: string | null; repos: { repo: string; command: string }[] }
}

export async function readAutomation(readers: AutomationReaders): Promise<AutomationView> {
  const read = await readers.topLevelLayers().then(
    (layers) => ({ layers }),
    (error: unknown) => ({ error: errorMessage(error) }),
  )
  const layers = 'layers' in read ? read.layers : []
  const watch = resolveWatchSettings(layers)
  const hooks = resolveHookSettings(layers)
  const slack = resolveSlackSettings(layers)
  const watchConfig = layers.find((layer) => layer.kind === 'user')?.config.watch
  return {
    configFile: readers.configFile,
    configured: 'error' in read || layers.length > 0,
    configError: 'error' in read ? read.error : null,
    watch:
      watch === undefined
        ? null
        : {
            intervalMs: watch.intervalMs,
            settleMs: watch.settleMs,
            maxReviewsPerHour: watch.maxReviewsPerHour,
            repos: watch.repos.map(({ repo }) => repo),
          },
    ci: userSettings(layers).filter(({ key }) => key.startsWith('ci.')),
    sources: {
      prComments: watch !== undefined,
      enqueue: watch !== undefined,
      mcp: watch !== undefined,
      slack:
        slack === undefined ? null : { channels: slack.channels, tokens: readers.slackTokens() },
    },
    hooks:
      hooks === undefined
        ? null
        : {
            events: REVIEW_EVENTS.map((event) => ({
              event,
              command: hooks.commands[event] ?? null,
            })),
            timeoutMs: hooks.timeoutMs,
          },
    when: {
      global: watchConfig?.when?.command ?? null,
      repos: (watchConfig?.repos ?? []).flatMap((entry) =>
        typeof entry === 'string' || entry.when === undefined
          ? []
          : [{ repo: entry.repo.toLowerCase(), command: entry.when.command }],
      ),
    },
  }
}
