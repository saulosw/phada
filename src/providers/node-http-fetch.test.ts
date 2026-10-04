import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeHttpFetch } from './node-http-fetch.js'

interface SeenRequest {
  method: string | undefined
  contentType: string | undefined
  body: string
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close))
})

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function close(server: Server): Promise<void> {
  server.closeAllConnections()
  return new Promise((resolve) => server.close(() => resolve()))
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function closedPortUrl(): Promise<string> {
  const url = await listen(() => undefined)
  const server = servers.pop()
  if (server !== undefined) await close(server)
  return url
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the request to reject')
    },
    (reason: unknown) => reason,
  )
}

describe('nodeHttpFetch', () => {
  it('sends the method, headers and body and resolves with the status and body', async () => {
    const seen: SeenRequest[] = []
    const url = await listen((request, response) => {
      void readBody(request).then((body) => {
        seen.push({ method: request.method, contentType: request.headers['content-type'], body })
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ answer: 'olá' }))
      })
    })

    const response = await nodeHttpFetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '漢字' }),
    })

    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ answer: 'olá' })
    expect(seen).toEqual([
      { method: 'POST', contentType: 'application/json', body: '{"question":"漢字"}' },
    ])
  })

  it('returns a status that is not 2xx instead of rejecting', async () => {
    const url = await listen((_request, response) => {
      response.writeHead(404)
      response.end('{"error":"model not found"}')
    })

    const response = await nodeHttpFetch(`${url}/api/show`, { method: 'POST', body: '{}' })

    expect(response.ok).toBe(false)
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('{"error":"model not found"}')
  })

  it('rejects with the TimeoutError of the signal when the server is slower than it', async () => {
    const url = await listen((_request, response) => {
      setTimeout(() => response.end('late'), 2000).unref()
    })

    const error = await rejection(
      nodeHttpFetch(`${url}/api/chat`, {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.timeout(200),
      }),
    )

    expect(error).toBeInstanceOf(DOMException)
    expect(error).toMatchObject({ name: 'TimeoutError' })
  })

  it('rejects like fetch, keeping the error code as the cause, when nothing listens', async () => {
    const url = await closedPortUrl()

    const error = await rejection(nodeHttpFetch(`${url}/api/show`, { method: 'POST' }))

    expect(error).toBeInstanceOf(TypeError)
    expect(error).toMatchObject({ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } })
  })
})
