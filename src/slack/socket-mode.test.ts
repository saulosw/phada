import { describe, expect, it } from 'vitest'
import { connectSocketMode } from './socket-mode.js'
import type { SocketLike } from './socket-mode.js'

type Listener = (event: { data?: unknown }) => void

class FakeSocket implements SocketLike {
  static opened: FakeSocket[] = []
  readonly url: string
  readonly sent: string[] = []
  closed = false
  readonly #listeners = new Map<string, Listener[]>()

  constructor(url: string) {
    this.url = url
    FakeSocket.opened.push(this)
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

function setup() {
  FakeSocket.opened = []
  const events: unknown[] = []
  const errors: string[] = []
  let urls = 0
  const connection = connectSocketMode({
    openUrl: async () => `wss://slack.test/${++urls}`,
    WebSocket: FakeSocket,
    onEvent: (event) => events.push(event),
    onError: (message) => errors.push(message),
    sleep: async () => undefined,
  })
  return { connection, events, errors, urls: () => urls }
}

describe('connectSocketMode', () => {
  it('acknowledges each envelope and hands over the events', async () => {
    const { events, connection } = setup()
    await flush()
    const socket = FakeSocket.opened[0]!

    socket.receive({ type: 'hello' })
    socket.receive({
      type: 'events_api',
      envelope_id: 'e1',
      payload: { event: { type: 'message', channel: 'C1', ts: '1.2', text: 'hi' } },
    })

    expect(socket.url).toBe('wss://slack.test/1')
    expect(socket.sent).toEqual(['{"envelope_id":"e1"}'])
    expect(events).toEqual([{ type: 'message', channel: 'C1', ts: '1.2', text: 'hi' }])
    connection.close()
  })

  it('opens a new connection when Slack asks to disconnect or the socket closes', async () => {
    const { connection, urls } = setup()
    await flush()

    FakeSocket.opened[0]!.receive({ type: 'disconnect', reason: 'refresh_requested' })
    await flush()
    FakeSocket.opened[1]!.close()
    await flush()

    expect(urls()).toBe(3)
    expect(FakeSocket.opened[0]!.closed).toBe(true)
    connection.close()
  })

  it('stops for good once closed', async () => {
    const { connection, urls } = setup()
    await flush()

    connection.close()
    await flush()

    expect(FakeSocket.opened[0]!.closed).toBe(true)
    expect(urls()).toBe(1)
  })

  it('reports a connection that cannot open and tries again', async () => {
    FakeSocket.opened = []
    const errors: string[] = []
    let calls = 0
    const connection = connectSocketMode({
      openUrl: async () => {
        calls += 1
        if (calls === 1) throw new Error('invalid_auth')
        return 'wss://slack.test/2'
      },
      WebSocket: FakeSocket,
      onEvent: () => undefined,
      onError: (message) => errors.push(message),
      sleep: async () => undefined,
    })
    await flush()
    await flush()

    expect(errors).toEqual(['Slack connection failed: invalid_auth'])
    expect(FakeSocket.opened).toHaveLength(1)
    connection.close()
  })
})
