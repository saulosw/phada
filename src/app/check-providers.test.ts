import { describe, expect, it } from 'vitest'
import { checkProviders } from './check-providers.js'
import type { ProviderCheckers } from './check-providers.js'
import type { CliStatus, OllamaStatus } from '../providers/types.js'

const CLAUDE: CliStatus = {
  provider: 'claude',
  install: { state: 'installed', version: '2.1.310' },
  login: { state: 'logged-in', method: 'claude.ai' },
}
const CODEX: CliStatus = {
  provider: 'codex',
  install: { state: 'missing' },
  login: { state: 'unknown', problem: 'not-installed' },
}
const OLLAMA: OllamaStatus = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  server: { state: 'running', version: '0.35.1', models: ['qwen2.5-coder:7b'] },
}

const checkers: ProviderCheckers = {
  claude: async () => CLAUDE,
  codex: async () => CODEX,
  ollama: async () => OLLAMA,
}

describe('checkProviders', () => {
  it('reports every provider and marks the chosen one', async () => {
    expect(await checkProviders(checkers, 'ollama')).toEqual([
      { ...CLAUDE, chosen: false },
      { ...CODEX, chosen: false },
      { ...OLLAMA, chosen: true },
    ])
  })

  it('marks none when no provider is chosen', async () => {
    const providers = await checkProviders(checkers, null)
    expect(providers.map((provider) => provider.chosen)).toEqual([false, false, false])
  })

  it('keeps the others when one checker fails', async () => {
    const broken: ProviderCheckers = {
      ...checkers,
      claude: async () => {
        throw new Error('boom')
      },
      ollama: async () => {
        throw new Error('boom')
      },
    }
    expect(await checkProviders(broken, 'claude')).toEqual([
      {
        provider: 'claude',
        install: { state: 'unknown', problem: 'failed' },
        login: { state: 'unknown', problem: 'failed' },
        chosen: true,
      },
      { ...CODEX, chosen: false },
      {
        provider: 'ollama',
        baseUrl: null,
        server: { state: 'unknown', problem: 'failed' },
        chosen: false,
      },
    ])
  })

  it('runs the checkers at the same time', async () => {
    let started = 0
    let releaseAll: () => void = () => undefined
    const allStarted = new Promise<void>((resolve) => {
      releaseAll = resolve
    })
    const together =
      <T>(status: T) =>
      async () => {
        started += 1
        if (started === 3) releaseAll()
        await allStarted
        return status
      }
    const providers = await checkProviders(
      { claude: together(CLAUDE), codex: together(CODEX), ollama: together(OLLAMA) },
      'claude',
    )
    expect(providers.map((provider) => provider.provider)).toEqual(['claude', 'codex', 'ollama'])
  })
})
