/** One scripted answer: an HTTP response, a network failure, or a request that never answers. */
export type FakeResponse =
  { status: number; body?: string; headers?: Record<string, string> } | 'network-error' | 'hang'

export interface FakeCall {
  url: string
  /** Only recorded when the request sets it, so GET-only callers see the original shape. */
  method?: string
  /** Lower-cased header names, as seen on the wire. */
  headers: Record<string, string>
  body?: string
}

/** Picks the queue that answers a call. The default routes by the Accept header. */
export type RouteKey = (call: FakeCall) => string

const byAccept: RouteKey = (call) => call.headers['accept'] ?? ''

/**
 * A fetch replacement that answers from per-route queues and records every call.
 * A request with no queued answer rejects with a "fakeFetch:" error; tests assert exact
 * messages, so an unexpected request can never pass for an expected failure.
 */
export function createFakeFetch(
  routes: Record<string, FakeResponse[]>,
  routeKey: RouteKey = byAccept,
): {
  fetch: typeof globalThis.fetch
  calls: FakeCall[]
} {
  const calls: FakeCall[] = []
  const queues = new Map(Object.entries(routes).map(([accept, answers]) => [accept, [...answers]]))

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const call: FakeCall = {
      url,
      ...(init?.method === undefined ? {} : { method: init.method }),
      headers,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    }
    calls.push(call)

    const key = routeKey(call)
    const answer = queues.get(key)?.shift()
    if (answer === undefined) {
      throw new Error(`fakeFetch: no response queued for "${key}" (${url})`)
    }
    if (answer === 'network-error') throw new TypeError('fetch failed')
    if (answer === 'hang') return hang(init?.signal)
    return new Response(answer.body ?? '', { status: answer.status, headers: answer.headers })
  }

  return { fetch, calls }
}

// Behaves like the real fetch on timeout: rejects with the signal's reason when it aborts.
function hang(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}
