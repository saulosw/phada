import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import type { FakeResponse } from '../../test/support/fake-fetch.js'
import { checkOllamaStatus } from './ollama-status.js'

const BASE_URL = 'http://127.0.0.1:11434'

function byPath(routes: { version?: FakeResponse[]; tags?: FakeResponse[] }) {
  return createFakeFetch(
    { '/api/version': routes.version ?? [], '/api/tags': routes.tags ?? [] },
    (call) => new URL(call.url).pathname,
  )
}

function tags(names: string[]): FakeResponse {
  return {
    status: 200,
    body: JSON.stringify({ models: names.map((name) => ({ name, model: name, size: 1 })) }),
  }
}

const VERSION: FakeResponse = { status: 200, body: JSON.stringify({ version: '0.35.1' }) }

const refused: typeof globalThis.fetch = async () => {
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
    code: 'ECONNREFUSED',
  })
  throw new TypeError('fetch failed', { cause })
}

describe('checkOllamaStatus', () => {
  it('reports a running server with its version and models', async () => {
    const { fetch, calls } = byPath({
      version: [VERSION],
      tags: [tags(['qwen2.5-coder:7b', 'llama3.1:8b'])],
    })
    expect(await checkOllamaStatus({ env: {}, fetch })).toEqual({
      provider: 'ollama',
      baseUrl: BASE_URL,
      server: { state: 'running', version: '0.35.1', models: ['qwen2.5-coder:7b', 'llama3.1:8b'] },
    })
    expect(calls.map((call) => call.url).sort()).toEqual([
      `${BASE_URL}/api/tags`,
      `${BASE_URL}/api/version`,
    ])
  })

  it('reports a running server without models', async () => {
    const { fetch } = byPath({ version: [VERSION], tags: [tags([])] })
    expect((await checkOllamaStatus({ env: {}, fetch })).server).toEqual({
      state: 'running',
      version: '0.35.1',
      models: [],
    })
  })

  it('asks the server OLLAMA_HOST names', async () => {
    const { fetch, calls } = byPath({ version: [VERSION], tags: [tags([])] })
    const status = await checkOllamaStatus({ env: { OLLAMA_HOST: 'gpu-box:9000' }, fetch })
    expect(status.baseUrl).toBe('http://gpu-box:9000')
    expect(calls.every((call) => call.url.startsWith('http://gpu-box:9000/api/'))).toBe(true)
  })

  it('reports a server that refuses the connection as stopped', async () => {
    expect((await checkOllamaStatus({ env: {}, fetch: refused })).server).toEqual({
      state: 'stopped',
    })
  })

  it('reports a server that does not answer in time', async () => {
    const { fetch } = byPath({ version: ['hang'], tags: ['hang'] })
    expect((await checkOllamaStatus({ env: {}, fetch, timeoutMs: 50 })).server).toEqual({
      state: 'unknown',
      problem: 'timeout',
    })
  })

  it('reports an HTTP error as a failure', async () => {
    const { fetch } = byPath({ version: [VERSION], tags: [{ status: 500, body: 'boom' }] })
    expect((await checkOllamaStatus({ env: {}, fetch })).server).toEqual({
      state: 'unknown',
      problem: 'failed',
    })
  })

  it('reports an answer that is not the model list', async () => {
    const { fetch } = byPath({ version: [VERSION], tags: [{ status: 200, body: '<html>' }] })
    expect((await checkOllamaStatus({ env: {}, fetch })).server).toEqual({
      state: 'unknown',
      problem: 'unexpected-output',
    })
  })

  it('keeps the models when only the version cannot be read', async () => {
    const { fetch } = byPath({ version: [{ status: 404 }], tags: [tags(['llama3.1:8b'])] })
    expect((await checkOllamaStatus({ env: {}, fetch })).server).toEqual({
      state: 'running',
      version: null,
      models: ['llama3.1:8b'],
    })
  })

  it('reports an OLLAMA_HOST that is not an address without asking anything', async () => {
    const { fetch, calls } = byPath({})
    expect(await checkOllamaStatus({ env: { OLLAMA_HOST: 'http://bad host' }, fetch })).toEqual({
      provider: 'ollama',
      baseUrl: null,
      server: { state: 'unknown', problem: 'invalid-host' },
    })
    expect(calls).toEqual([])
  })
})
