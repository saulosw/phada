import { request as httpRequest } from 'node:http'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'

type Send = (url: URL, options: RequestOptions) => ClientRequest

const SENDERS: Readonly<Record<string, Send>> = {
  'http:': (url, options) => httpRequest(url, options),
  'https:': (url, options) => httpsRequest(url, options),
}
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304])

export const nodeHttpFetch: typeof globalThis.fetch = (input, init) =>
  new Promise<Response>((resolve, reject) => {
    const signal = init?.signal ?? undefined
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const url = input instanceof Request ? undefined : new URL(input)
    const send = url === undefined ? undefined : SENDERS[url.protocol]
    const body = init?.body ?? undefined
    if (url === undefined || send === undefined || !isTextBody(body)) {
      reject(new TypeError('fetch failed', { cause: new Error('Unsupported request') }))
      return
    }

    const outgoing = send(url, {
      method: init?.method ?? 'GET',
      headers: requestHeaders(init?.headers, body),
    })
    const onAbort = () => outgoing.destroy(signal?.reason)
    const release = () => signal?.removeEventListener('abort', onAbort)
    signal?.addEventListener('abort', onAbort, { once: true })
    outgoing.on('error', (error) => {
      release()
      reject(signal?.aborted ? signal.reason : new TypeError('fetch failed', { cause: error }))
    })
    outgoing.on('response', (incoming) => resolve(toResponse(incoming, signal, release)))
    outgoing.end(body)
  })

function isTextBody(body: unknown): body is string | undefined {
  return body === undefined || typeof body === 'string'
}

function requestHeaders(headers: RequestInit['headers'], body: string | undefined) {
  const result = Object.fromEntries(new Headers(headers).entries())
  if (body !== undefined) result['content-length'] = String(Buffer.byteLength(body))
  return result
}

function toResponse(
  incoming: IncomingMessage,
  signal: AbortSignal | undefined,
  release: () => void,
): Response {
  const status = incoming.statusCode ?? 0
  const init = { status, statusText: incoming.statusMessage ?? '' }
  if (NULL_BODY_STATUSES.has(status)) {
    incoming.resume()
    incoming.once('end', release)
    return new Response(null, init)
  }
  return new Response(bodyOf(incoming, signal, release), init)
}

function bodyOf(
  incoming: IncomingMessage,
  signal: AbortSignal | undefined,
  release: () => void,
): ReadableStream<Uint8Array> {
  const chunks = incoming[Symbol.asyncIterator]()
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = (await chunks.next()) as IteratorResult<Buffer>
        if (!next.done) return controller.enqueue(new Uint8Array(next.value))
        release()
        controller.close()
      } catch (error) {
        release()
        controller.error(
          signal?.aborted ? signal.reason : new TypeError('terminated', { cause: error }),
        )
      }
    },
    cancel() {
      release()
      incoming.destroy()
    },
  })
}
