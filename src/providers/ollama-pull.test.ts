import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import type { FakeResponse } from '../../test/support/fake-fetch.js'
import { pullOllamaModel } from './ollama-pull.js'
import type { OllamaPullProgress } from './types.js'

const MODEL = 'qwen2.5-coder:7b'

function lines(...answers: object[]): FakeResponse {
  return { status: 200, body: answers.map((answer) => `${JSON.stringify(answer)}\n`).join('') }
}

function pullFetch(...answers: FakeResponse[]) {
  return createFakeFetch({ '/api/pull': answers }, (call) => new URL(call.url).pathname)
}

function streamingFetch(first: string, seen: { cancelled: boolean }): typeof globalThis.fetch {
  return async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(first))
        },
        cancel() {
          seen.cancelled = true
        },
      }),
      { status: 200 },
    )
}

const refused: typeof globalThis.fetch = async () => {
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
    code: 'ECONNREFUSED',
  })
  throw new TypeError('fetch failed', { cause })
}

describe('pullOllamaModel', () => {
  it('asks Ollama to pull the model and reports each step with its bytes', async () => {
    const { fetch, calls } = pullFetch(
      lines(
        { status: 'pulling manifest' },
        { status: 'pulling 60e05f210007', digest: 'sha256:60e0', total: 4_683_073_184 },
        {
          status: 'pulling 60e05f210007',
          digest: 'sha256:60e0',
          total: 4_683_073_184,
          completed: 1_170_768_296,
        },
        { status: 'verifying sha256 digest' },
        { status: 'success' },
      ),
    )
    const seen: OllamaPullProgress[] = []

    const result = await pullOllamaModel(MODEL, {
      env: {},
      fetch,
      onProgress: (progress) => seen.push(progress),
    })

    expect(result).toEqual({ kind: 'pulled' })
    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:11434/api/pull',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, stream: true }),
      },
    ])
    expect(seen).toEqual([
      { status: 'pulling manifest', completed: null, total: null },
      { status: 'pulling 60e05f210007', completed: null, total: 4_683_073_184 },
      { status: 'pulling 60e05f210007', completed: 1_170_768_296, total: 4_683_073_184 },
      { status: 'verifying sha256 digest', completed: null, total: null },
      { status: 'success', completed: null, total: null },
    ])
  })

  it('reads a line split across chunks', async () => {
    const encoder = new TextEncoder()
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('{"status":"pulling man'))
            controller.enqueue(encoder.encode('ifest"}\n{"status":"succ'))
            controller.enqueue(encoder.encode('ess"}'))
            controller.close()
          },
        }),
        { status: 200 },
      )
    const seen: string[] = []

    const result = await pullOllamaModel(MODEL, {
      env: {},
      fetch,
      onProgress: ({ status }) => seen.push(status),
    })

    expect(result).toEqual({ kind: 'pulled' })
    expect(seen).toEqual(['pulling manifest', 'success'])
  })

  it('fails with the error Ollama writes in the stream', async () => {
    const { fetch } = pullFetch(
      lines({ status: 'pulling manifest' }, { error: 'pull model manifest: file does not exist' }),
    )

    expect(await pullOllamaModel('nope:1b', { env: {}, fetch })).toEqual({
      kind: 'failed',
      message: 'pull model manifest: file does not exist',
    })
  })

  it('fails with the error of an HTTP answer that is not 2xx', async () => {
    const { fetch } = pullFetch(
      { status: 500, body: JSON.stringify({ error: 'disk full' }) },
      { status: 502, body: '<html>bad gateway</html>' },
    )

    expect(await pullOllamaModel(MODEL, { env: {}, fetch })).toEqual({
      kind: 'failed',
      message: 'disk full',
    })
    expect(await pullOllamaModel(MODEL, { env: {}, fetch })).toEqual({
      kind: 'failed',
      message: 'HTTP 502',
    })
  })

  it('fails when the stream ends before Ollama says it succeeded', async () => {
    const { fetch } = pullFetch(lines({ status: 'pulling manifest' }))

    expect(await pullOllamaModel(MODEL, { env: {}, fetch })).toEqual({
      kind: 'failed',
      message: null,
    })
  })

  it('reports a server that refuses the connection as stopped', async () => {
    expect(await pullOllamaModel(MODEL, { env: {}, fetch: refused })).toEqual({
      kind: 'stopped',
    })
  })

  it('is cancelled when the signal aborts before Ollama answers', async () => {
    const { fetch } = pullFetch('hang')
    const controller = new AbortController()

    const pulling = pullOllamaModel(MODEL, { env: {}, fetch, signal: controller.signal })
    controller.abort()

    expect(await pulling).toEqual({ kind: 'cancelled' })
  })

  it('stops reading and is cancelled when the signal aborts during the download', async () => {
    const seen = { cancelled: false }
    const controller = new AbortController()
    const fetch = streamingFetch(
      '{"status":"pulling 60e05f210007","total":10,"completed":1}\n',
      seen,
    )

    const result = await pullOllamaModel(MODEL, {
      env: {},
      fetch,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    })

    expect(result).toEqual({ kind: 'cancelled' })
    expect(seen.cancelled).toBe(true)
  })

  it('pulls from the server OLLAMA_HOST names', async () => {
    const { fetch, calls } = pullFetch(lines({ status: 'success' }))

    await pullOllamaModel(MODEL, { env: { OLLAMA_HOST: 'gpu-box:9000' }, fetch })

    expect(calls.map((call) => call.url)).toEqual(['http://gpu-box:9000/api/pull'])
  })

  it('fails without asking anything when OLLAMA_HOST is not an address', async () => {
    const { fetch, calls } = pullFetch()

    const result = await pullOllamaModel(MODEL, { env: { OLLAMA_HOST: 'http://bad host' }, fetch })

    expect(result).toEqual({
      kind: 'failed',
      message: 'OLLAMA_HOST "http://bad host" is not a valid address.',
    })
    expect(calls).toEqual([])
  })
})
