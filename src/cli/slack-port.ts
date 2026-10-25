import { errorMessage } from '../app/error-message.js'
import { submitRequest } from '../app/submit-request.js'
import type { SubmitDeps } from '../app/submit-request.js'
import type { SlackChannelSettings, SlackSettings } from '../config/watch-settings.js'
import { pullRequestLinks } from '../slack/pull-links.js'
import type { SlackWebApi } from '../slack/web-api.js'
import type { HistoryStore } from '../store/history-store.js'
import type { JobRecord } from '../watch/types.js'
import { refusalText } from './format-request.js'
import { slackReplies } from './format-slack.js'
import { eventOfJob } from './review-event.js'
import type { ReviewEvent } from './review-event.js'

export interface SlackPortDeps {
  settings: SlackSettings
  history: HistoryStore
  submit: SubmitDeps
  api: SlackWebApi
  warning(message: string): void
}

export interface SlackPort {
  onMessage(event: Record<string, unknown>): Promise<void>
  onJobEvent(event: ReviewEvent): Promise<void>
}

interface SlackPlace {
  channel: string
  ts: string
  thread: string
}

const ENDED = new Set(['review.finished', 'review.failed', 'review.skipped'])

export function slackPort(deps: SlackPortDeps): SlackPort {
  const { api, settings } = deps
  const channelOf = (id: string): SlackChannelSettings | undefined =>
    settings.channels.find((channel) => channel.id === id)
  const safely = async (work: () => Promise<void>) => {
    try {
      await work()
    } catch (error) {
      deps.warning(`Slack: ${errorMessage(error)}`)
    }
  }
  const answer = async (place: SlackPlace, event: ReviewEvent, channel?: SlackChannelSettings) => {
    if (event.verdict !== null) {
      await api.addReaction(place.channel, place.ts, settings.emojis[event.verdict])
    }
    for (const text of slackReplies(event, channel?.reply ?? 'link', settings.emojis)) {
      await api.postMessage(place.channel, place.thread, text)
    }
  }
  return {
    onMessage: async (event) => {
      const place = placeOf(event)
      if (place === undefined) return
      const channel = channelOf(place.channel)
      if (channel === undefined) return
      for (const link of pullRequestLinks(typeof event.text === 'string' ? event.text : '')) {
        await safely(async () => {
          const result = await submitRequest(
            { ...link, source: 'slack', publish: channel.publish, data: { ...place } },
            deps.submit,
          )
          if (result.status !== 'refused') {
            await api.addReaction(place.channel, place.ts, settings.emojis.queued)
            return
          }
          if (result.reason === 'not-watched') return
          const stored = result.job === undefined ? undefined : eventOfJob(deps.history, result.job)
          if (result.reason === 'already-reviewed' && stored !== undefined) {
            await answer(place, stored, channel)
            return
          }
          await api.postMessage(
            place.channel,
            place.thread,
            `:no_entry_sign: Not reviewed: ${refusalText(result)}.`,
          )
        })
      }
    },
    onJobEvent: async (event) => {
      if (!ENDED.has(event.event)) return
      for (const request of event.requests) {
        if (request.source !== 'slack') continue
        const place = storedPlace(request.data)
        if (place === undefined) continue
        await safely(async () => {
          await api.removeReaction(place.channel, place.ts, settings.emojis.queued)
          if (event.verdict !== 'skipped' && !otherSkipped(deps.history, place, event.job)) {
            await api.removeReaction(place.channel, place.ts, settings.emojis.skipped)
          }
          await answer(place, event, channelOf(place.channel))
        })
      }
    },
  }
}

function otherSkipped(
  history: HistoryStore,
  place: SlackPlace,
  job: Pick<JobRecord, 'repo' | 'number'>,
): boolean {
  const latest = new Map<string, JobRecord>()
  for (const { jobId } of history.requestsWith('slack', { channel: place.channel, ts: place.ts })) {
    const other = history.job(jobId)
    if (other === undefined || (other.repo === job.repo && other.number === job.number)) continue
    const key = `${other.repo}#${other.number}`
    if ((latest.get(key)?.id ?? 0) < other.id) latest.set(key, other)
  }
  return [...latest.values()].some(({ status }) => status === 'skipped')
}

function placeOf(event: Record<string, unknown>): SlackPlace | undefined {
  if (event.type !== 'message' || event.subtype !== undefined || event.bot_id !== undefined) {
    return undefined
  }
  const { channel, ts } = event
  if (typeof channel !== 'string' || typeof ts !== 'string') return undefined
  const thread = typeof event.thread_ts === 'string' ? event.thread_ts : ts
  return { channel, ts, thread }
}

function storedPlace(data: Record<string, unknown> | undefined): SlackPlace | undefined {
  const { channel, ts, thread } = data ?? {}
  if (typeof channel !== 'string' || typeof ts !== 'string') return undefined
  return { channel, ts, thread: typeof thread === 'string' ? thread : ts }
}
