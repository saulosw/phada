const API = 'https://slack.com/api'
const DEFAULT_TIMEOUT_MS = 30_000
const HARMLESS = new Set(['already_reacted', 'no_reaction'])

export class SlackApiError extends Error {
  override readonly name = 'SlackApiError'
  readonly method: string
  readonly code: string

  constructor(method: string, code: string) {
    super(`Slack ${method} failed: ${code}`)
    this.method = method
    this.code = code
  }
}

export interface SlackWebApiOptions {
  botToken: string
  appToken: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export interface SlackWebApi {
  postMessage(channel: string, threadTs: string, text: string): Promise<void>
  addReaction(channel: string, ts: string, name: string): Promise<void>
  removeReaction(channel: string, ts: string, name: string): Promise<void>
  openConnection(): Promise<string>
}

export function slackWebApi(options: SlackWebApiOptions): SlackWebApi {
  const call = (method: string, token: string, body: Record<string, unknown>) =>
    callSlack(method, token, body, options)
  return {
    postMessage: async (channel, threadTs, text) => {
      await call('chat.postMessage', options.botToken, {
        channel,
        thread_ts: threadTs,
        text,
        unfurl_links: false,
        unfurl_media: false,
      })
    },
    addReaction: async (channel, ts, name) => {
      await call('reactions.add', options.botToken, { channel, timestamp: ts, name })
    },
    removeReaction: async (channel, ts, name) => {
      await call('reactions.remove', options.botToken, { channel, timestamp: ts, name })
    },
    openConnection: async () => {
      const answer = await call('apps.connections.open', options.appToken, {})
      if (typeof answer.url !== 'string') throw new SlackApiError('apps.connections.open', 'no_url')
      return answer.url
    },
  }
}

async function callSlack(
  method: string,
  token: string,
  body: Record<string, unknown>,
  options: SlackWebApiOptions,
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await (options.fetch ?? globalThis.fetch)(`${API}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch (error) {
    throw new SlackApiError(method, error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) throw new SlackApiError(method, `HTTP ${response.status}`)
  const answer = (await response.json()) as Record<string, unknown>
  if (answer.ok === true) return answer
  const code = typeof answer.error === 'string' ? answer.error : 'unknown_error'
  if (HARMLESS.has(code)) return answer
  throw new SlackApiError(method, code)
}
