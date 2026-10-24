import { describe, expect, it } from 'vitest'
import { connectSocketMode } from './socket-mode.js'
import type { SocketLike } from './socket-mode.js'

type Listener = (event: { data?: unknown }) => void

class FakeSocket implements SocketLike {
  readonly url: string
  readonly sent: string[] = []
  closed = false
  readonly #listeners = new Map<string, Listener[]>()

  constructor(url: string) {
    this.url = url
  }

  addEventListener(type: string, listener: Listener): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener])
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close', {})
  }

  emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event)
  }

  receive(message: unknown): void {
    this.emit('message', { data: JSON.stringify(message) })
  }
}

const flush = () => new Promise((done) => setTimeout(done, 0))

function setup(openUrl?: () => Promise<string>) {
  const opened: FakeSocket[] = []
  const events: unknown[] = []
  const errors: string[] = []
  const sleeps: number[] = []
  let urls = 0
  const connection = connectSocketMode({
    openUrl: openUrl ?? (async () => `wss://slack.test/${++urls}`),
    WebSocket: class extends FakeSocket {
      constructor(url: string) {
        super(url)
        opened.push(this)
      }
    },
    onEvent: (event) => events.push(event),
    onError: (message) => errors.push(message),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  })
  const latest = (): FakeSocket => {
    const socket = opened.at(-1)
    if (socket === undefined) throw new Error('no socket was opened')
    return socket
  }
  return { connection, opened, latest, events, errors, sleeps, urls: () => urls }
}

describe('connectSocketMode', () => {
  it('acknowledges each envelope and hands over the events', async () => {
    const h = setup()
    await flush()

    h.latest().receive({ type: 'hello' })
    h.latest().receive({
      type: 'events_api',
      envelope_id: 'e1',
      payload: { event: { type: 'message', channel: 'C1', ts: '1.2', text: 'hi' } },
    })

    expect(h.latest().url).toBe('wss://slack.test/1')
    expect(h.latest().sent).toEqual(['{"envelope_id":"e1"}'])
    expect(h.events).toEqual([{ type: 'message', channel: 'C1', ts: '1.2', text: 'hi' }])
    h.connection.close()
  })

  it('opens a new connection at once when Slack asks to', async () => {
    const h = setup()
    await flush()

    h.latest().receive({ type: 'hello' })
    h.latest().receive({ type: 'disconnect', reason: 'refresh_requested' })
    await flush()

    expect(h.urls()).toBe(2)
    expect(h.opened[0]?.closed).toBe(true)
    expect(h.sleeps).toEqual([])
    h.connection.close()
  })

  it('opens a new connection a second after the socket drops', async () => {
    const h = setup()
    await flush()

    h.latest().receive({ type: 'hello' })
    h.latest().close()
    await flush()

    expect(h.urls()).toBe(2)
    expect(h.sleeps).toEqual([1_000])
    h.connection.close()
  })

  it('waits longer before each new try when sockets keep closing before Slack says hello', async () => {
    const h = setup()
    for (let attempt = 0; attempt < 4; attempt++) {
      await flush()
      h.latest().close()
    }
    await flush()

    expect(h.sleeps).toEqual([1_000, 5_000, 30_000, 30_000])
    h.connection.close()
  })

  it('stops for good once closed', async () => {
    const h = setup()
    await flush()

    h.connection.close()
    await flush()

    expect(h.latest().closed).toBe(true)
    expect(h.urls()).toBe(1)
  })

  it('reports a connection that cannot open and tries again', async () => {
    let calls = 0
    const h = setup(async () => {
      calls += 1
      if (calls === 1) throw new Error('invalid_auth')
      return 'wss://slack.test/2'
    })
    await flush()
    await flush()

    expect(h.errors).toEqual(['Slack connection failed: invalid_auth'])
    expect(h.opened).toHaveLength(1)
    h.connection.close()
  })
})
