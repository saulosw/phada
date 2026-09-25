/** One scripted answer: an HTTP response, a network failure, or a request that never answers. */
export type FakeResponse =
  { status: number; body?: string; headers?: Record<string, string> } | 'network-error' | 'hang'

export interface FakeCall {
  url: string
  /** Lower-cased header names, as seen on the wire. */
  headers: Record<string, string>
}

/**
 * A fetch replacement that answers from per-Accept queues and records every call.
 * A request with no queued answer rejects with a "fakeFetch:" error; tests assert exact
 * messages, so an unexpected request can never pass for an expected failure.
 */
export function createFakeFetch(routes: Record<string, FakeResponse[]>): {
  fetch: typeof globalThis.fetch
  calls: FakeCall[]
} {
  const calls: FakeCall[] = []
  const queues = new Map(Object.entries(routes).map(([accept, answers]) => [accept, [...answers]]))

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    calls.push({ url, headers })

    const answer = queues.get(headers['accept'] ?? '')?.shift()
    if (answer === undefined) {
      throw new Error(`fakeFetch: no response queued for Accept "${headers['accept']}" (${url})`)
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
