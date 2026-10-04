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
    const fail = (error: unknown) => {
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.aborted ? signal.reason : new TypeError('fetch failed', { cause: error }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    outgoing.on('error', fail)
    outgoing.on('response', (incoming) => {
      readText(incoming).then((text) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(toResponse(incoming, text))
      }, fail)
    })
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

async function readText(incoming: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of incoming) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function toResponse(incoming: IncomingMessage, text: string): Response {
  const status = incoming.statusCode ?? 0
  return new Response(NULL_BODY_STATUSES.has(status) ? null : text, {
    status,
    statusText: incoming.statusMessage ?? '',
  })
}
