const RETRY_DELAYS_MS = [1_000, 5_000, 30_000]

export interface SocketLike {
  send(data: string): void
  close(): void
  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: (event: { data?: unknown }) => void,
  ): void
}

export interface SocketModeOptions {
  openUrl(): Promise<string>
  WebSocket?: new (url: string) => SocketLike
  onEvent(event: Record<string, unknown>): void
  onError(message: string): void
  sleep?(ms: number): Promise<void>
}

export interface SocketModeConnection {
  close(): void
}

export function connectSocketMode(options: SocketModeOptions): SocketModeConnection {
  const Socket =
    options.WebSocket ?? (globalThis.WebSocket as unknown as new (url: string) => SocketLike)
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  let stopped = false
  let current: SocketLike | undefined
  let failures = 0

  const connect = async (): Promise<void> => {
    while (!stopped) {
      try {
        const url = await options.openUrl()
        if (stopped) return
        failures = 0
        current = open(url)
        return
      } catch (error) {
        options.onError(
          `Slack connection failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        await sleep(RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)] ?? 30_000)
        failures += 1
      }
    }
  }

  const open = (url: string): SocketLike => {
    const socket = new Socket(url)
    let replaced = false
    const reconnect = () => {
      if (replaced || stopped) return
      replaced = true
      socket.close()
      void connect()
    }
    socket.addEventListener('message', ({ data }) => {
      const message = parse(data)
      if (message === undefined) return
      if (typeof message.envelope_id === 'string') {
        socket.send(JSON.stringify({ envelope_id: message.envelope_id }))
      }
      if (message.type === 'disconnect') return reconnect()
      const event = (message.payload as { event?: unknown } | undefined)?.event
      if (message.type === 'events_api' && typeof event === 'object' && event !== null) {
        options.onEvent(event as Record<string, unknown>)
      }
    })
    socket.addEventListener('close', reconnect)
    socket.addEventListener('error', () =>
      options.onError('Slack connection dropped; reconnecting.'),
    )
    return socket
  }

  void connect()
  return {
    close: () => {
      stopped = true
      current?.close()
    },
  }
}

function parse(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== 'string') return undefined
  try {
    const value: unknown = JSON.parse(data)
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
