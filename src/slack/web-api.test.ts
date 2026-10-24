import { describe, expect, it } from 'vitest'
import { SlackApiError, slackWebApi } from './web-api.js'

const BOT = 'xoxb-test-bot-token'
const APP = 'xapp-test-app-token'

function fakeSlack(answers: Record<string, unknown>) {
  const calls: { url: string; auth: string | null; body: unknown }[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({
      url,
      auth: headers.get('authorization'),
      body: JSON.parse(String(init?.body ?? '{}')),
    })
    const method = url.split('/').at(-1) ?? ''
    return new Response(JSON.stringify(answers[method] ?? { ok: true }), { status: 200 })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

describe('slackWebApi', () => {
  it('posts a reply in the thread of a message with the bot token', async () => {
    const { fetch, calls } = fakeSlack({})
    await slackWebApi({ botToken: BOT, appToken: APP, fetch }).postMessage('C1', '1.2', 'hi')
    expect(calls).toEqual([
      {
        url: 'https://slack.com/api/chat.postMessage',
        auth: `Bearer ${BOT}`,
        body: {
          channel: 'C1',
          thread_ts: '1.2',
          text: 'hi',
          unfurl_links: false,
          unfurl_media: false,
        },
      },
    ])
  })

  it('adds and removes reactions, and does not mind one already there or gone', async () => {
    const { fetch, calls } = fakeSlack({
      'reactions.add': { ok: false, error: 'already_reacted' },
      'reactions.remove': { ok: false, error: 'no_reaction' },
    })
    const api = slackWebApi({ botToken: BOT, appToken: APP, fetch })
    await api.addReaction('C1', '1.2', 'eyes')
    await api.removeReaction('C1', '1.2', 'eyes')
    expect(calls.map(({ url, body }) => [url.split('/').at(-1), body])).toEqual([
      ['reactions.add', { channel: 'C1', timestamp: '1.2', name: 'eyes' }],
      ['reactions.remove', { channel: 'C1', timestamp: '1.2', name: 'eyes' }],
    ])
  })

  it('opens a Socket Mode connection with the app token', async () => {
    const { fetch, calls } = fakeSlack({
      'apps.connections.open': { ok: true, url: 'wss://wss.slack.test/link' },
    })
    expect(await slackWebApi({ botToken: BOT, appToken: APP, fetch }).openConnection()).toBe(
      'wss://wss.slack.test/link',
    )
    expect(calls[0]?.auth).toBe(`Bearer ${APP}`)
  })

  it('throws the Slack error of a call, without the token', async () => {
    const { fetch } = fakeSlack({ 'chat.postMessage': { ok: false, error: 'not_in_channel' } })
    const error = await slackWebApi({ botToken: BOT, appToken: APP, fetch })
      .postMessage('C1', '1.2', 'hi')
      .catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(SlackApiError)
    expect((error as Error).message).toBe('Slack chat.postMessage failed: not_in_channel')
  })
})
