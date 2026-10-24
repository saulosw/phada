import type { SubmitDeps } from '../app/submit-request.js'
import type { ConfigLayer } from '../config/types.js'
import { resolveHookSettings, resolveSlackSettings } from '../config/watch-settings.js'
import type { HookSettings, SlackSettings } from '../config/watch-settings.js'
import { connectSocketMode } from '../slack/socket-mode.js'
import { slackWebApi } from '../slack/web-api.js'
import type { HistoryStore } from '../store/history-store.js'
import { UsageError } from './errors.js'
import type { ReviewEvent } from './review-event.js'
import { runHook } from './run-hook.js'
import { slackPort } from './slack-port.js'

export const SLACK_BOT_TOKEN = 'PHADA_SLACK_BOT_TOKEN'
export const SLACK_APP_TOKEN = 'PHADA_SLACK_APP_TOKEN'

export type ReviewEventSink = (event: ReviewEvent) => Promise<void>

export interface SlackConnection {
  settings: SlackSettings
  botToken: string
  appToken: string
}

export interface ReviewEventSinkSettings {
  hooks?: HookSettings
  slack?: SlackConnection
}

export interface ReviewEventSinkDeps {
  env: NodeJS.ProcessEnv
  runHook?: typeof runHook
  slackApi?: typeof slackWebApi
  connectSlack?: typeof connectSocketMode
}

export interface OpenedSinks {
  sinks: ReviewEventSink[]
  close(): void
}

export function reviewEventSinkSettings(
  layers: readonly ConfigLayer[],
  env: NodeJS.ProcessEnv,
): ReviewEventSinkSettings {
  const hooks = resolveHookSettings(layers)
  const slack = resolveSlackSettings(layers)
  return {
    ...(hooks === undefined ? {} : { hooks }),
    ...(slack === undefined ? {} : { slack: slackConnection(slack, env) }),
  }
}

export function openReviewEventSinks(
  settings: ReviewEventSinkSettings,
  context: {
    history: HistoryStore
    submit: SubmitDeps
    listen: boolean
    warning(message: string): void
  },
  deps: ReviewEventSinkDeps,
): OpenedSinks {
  const { hooks, slack } = settings
  const sinks: ReviewEventSink[] = []
  if (hooks !== undefined) {
    sinks.push(async (event) => {
      const warning = await (deps.runHook ?? runHook)(event, hooks, deps.env)
      if (warning !== undefined) context.warning(warning)
    })
  }
  if (slack === undefined) return { sinks, close: () => undefined }
  const api = (deps.slackApi ?? slackWebApi)({
    botToken: slack.botToken,
    appToken: slack.appToken,
  })
  const port = slackPort({
    settings: slack.settings,
    history: context.history,
    submit: context.submit,
    api,
    warning: context.warning,
  })
  sinks.push((event) => port.onJobEvent(event))
  const connection = context.listen
    ? (deps.connectSlack ?? connectSocketMode)({
        openUrl: () => api.openConnection(),
        onEvent: (event) => void port.onMessage(event),
        onError: context.warning,
      })
    : undefined
  return { sinks, close: () => connection?.close() }
}

function slackConnection(settings: SlackSettings, env: NodeJS.ProcessEnv): SlackConnection {
  const botToken = env[SLACK_BOT_TOKEN]?.trim()
  const appToken = env[SLACK_APP_TOKEN]?.trim()
  if (botToken && appToken) return { settings, botToken, appToken }
  const missing = [botToken ? [] : [SLACK_BOT_TOKEN], appToken ? [] : [SLACK_APP_TOKEN]].flat()
  throw new UsageError(
    `slack: in your config needs ${SLACK_BOT_TOKEN} and ${SLACK_APP_TOKEN} in the environment; ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set.`,
  )
}
