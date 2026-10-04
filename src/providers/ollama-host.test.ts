import { describe, expect, it } from 'vitest'
import { resolveOllamaBaseUrl } from './ollama-host.js'
import { ProviderError } from './types.js'

describe('resolveOllamaBaseUrl', () => {
  it.each([
    [undefined, 'http://127.0.0.1:11434'],
    ['', 'http://127.0.0.1:11434'],
    ['   ', 'http://127.0.0.1:11434'],
    ['127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['localhost', 'http://localhost:11434'],
    ['0.0.0.0', 'http://127.0.0.1:11434'],
    ['0.0.0.0:8080', 'http://127.0.0.1:8080'],
    ['[::]:11434', 'http://127.0.0.1:11434'],
    [':11999', 'http://127.0.0.1:11999'],
    ['::1', 'http://[::1]:11434'],
    ['[::1]', 'http://[::1]:11434'],
    ['[::1]:8080', 'http://[::1]:8080'],
    ['ollama.internal:80', 'http://ollama.internal'],
    ['gpu-box/proxy/', 'http://gpu-box:11434/proxy'],
    ['http://gpu-box:9000/', 'http://gpu-box:9000'],
    ['http://ollama.internal', 'http://ollama.internal'],
    ['https://ollama.example.com', 'https://ollama.example.com'],
    ['https://ollama.example.com/proxy/', 'https://ollama.example.com/proxy'],
  ])('resolves OLLAMA_HOST=%j to %s', (host, expected) => {
    expect(resolveOllamaBaseUrl(host === undefined ? {} : { OLLAMA_HOST: host })).toBe(expected)
  })

  it('reports an OLLAMA_HOST that is not an address', () => {
    expect(() => resolveOllamaBaseUrl({ OLLAMA_HOST: 'http://' })).toThrow(ProviderError)
    expect(() => resolveOllamaBaseUrl({ OLLAMA_HOST: 'http://' })).toThrow(
      'OLLAMA_HOST "http://" is not a valid address.',
    )
  })
})
