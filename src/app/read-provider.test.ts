import { describe, expect, it } from 'vitest'
import type { ConfigFile } from '../config/schema.js'
import type { ConfigLayer } from '../config/types.js'
import type { CheckedProvider } from './check-providers.js'
import { nextStep, providerSetup, readProviders } from './read-provider.js'

const CONFIG_PATH = '/home/ana/.config/phada/config.yml'

function layers(config: ConfigFile): ConfigLayer[] {
  return [{ kind: 'user', dir: '', configLabel: 'user:config.yml', config }]
}

const CHECKERS = {
  claude: async () => ({
    provider: 'claude' as const,
    install: { state: 'installed' as const, version: '2.1.0' },
    login: { state: 'logged-in' as const, method: 'claude.ai' },
  }),
  codex: async () => ({
    provider: 'codex' as const,
    install: { state: 'missing' as const },
    login: { state: 'unknown' as const, problem: 'not-installed' as const },
  }),
  ollama: async () => ({
    provider: 'ollama' as const,
    baseUrl: null,
    server: { state: 'stopped' as const },
  }),
}

describe('providerSetup', () => {
  it("falls back to Phada's default provider without a user config", () => {
    expect(providerSetup({ layers: [], configPath: CONFIG_PATH })).toEqual({
      choice: { provider: 'claude', model: null, origin: { kind: 'default' } },
      mcp: [],
    })
  })

  it('says the user config chose the provider and the model', () => {
    expect(
      providerSetup({
        layers: layers({ provider: 'ollama', model: 'qwen2.5-coder:7b' }),
        configPath: CONFIG_PATH,
      }).choice,
    ).toEqual({
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
      origin: { kind: 'user-config', path: CONFIG_PATH },
    })
  })

  it('lists the MCP servers by name and kind, never their command, env, URL or headers', () => {
    const setup = providerSetup({
      layers: layers({
        mcp: [
          'github',
          { name: 'linear', tools: ['search'] },
          {
            name: 'docs',
            command: 'docs-server',
            args: ['--token', 'abc123'],
            env: { DOCS_TOKEN: '${DOCS_TOKEN}' },
            description: 'Internal docs',
          },
          {
            name: 'tracker',
            url: 'https://tracker.example/mcp?key=s3cret',
            headers: { Authorization: 'Bearer x' },
          },
        ],
      }),
      configPath: CONFIG_PATH,
    })
    expect(setup.mcp).toEqual([
      { name: 'github', kind: 'named', tools: [], description: null },
      { name: 'linear', kind: 'named', tools: ['search'], description: null },
      { name: 'docs', kind: 'command', tools: [], description: 'Internal docs' },
      { name: 'tracker', kind: 'http', tools: [], description: null },
    ])
    expect(JSON.stringify(setup)).not.toMatch(/abc123|DOCS_TOKEN|s3cret|Bearer|docs-server/)
  })
})

describe('readProviders', () => {
  it('checks every provider and marks the chosen one', async () => {
    const report = await readProviders({
      layers: layers({ provider: 'codex' }),
      configPath: CONFIG_PATH,
      checkers: CHECKERS,
    })
    expect(report.choice.provider).toBe('codex')
    expect(report.providers.map(({ provider, chosen }) => [provider, chosen])).toEqual([
      ['claude', false],
      ['codex', true],
      ['ollama', false],
    ])
  })
})

describe('nextStep', () => {
  const cli = (
    provider: 'claude' | 'codex',
    install: Extract<CheckedProvider, { install: unknown }>['install'],
    login: Extract<CheckedProvider, { install: unknown }>['login'],
  ): CheckedProvider => ({ provider, install, login, chosen: false })
  const ollama = (
    server: Extract<CheckedProvider, { server: unknown }>['server'],
    chosen = false,
  ) =>
    ({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', server, chosen }) as CheckedProvider
  const installed = { state: 'installed' as const, version: '1.0.0' }

  it('installs a missing CLI and logs in a logged-out one', () => {
    expect(
      nextStep(
        cli('claude', { state: 'missing' }, { state: 'unknown', problem: 'not-installed' }),
        null,
      ),
    ).toEqual({
      kind: 'install',
      command: 'npm install -g @anthropic-ai/claude-code',
    })
    expect(
      nextStep(
        cli('codex', { state: 'missing' }, { state: 'unknown', problem: 'not-installed' }),
        null,
      ),
    ).toEqual({
      kind: 'install',
      command: 'npm install -g @openai/codex',
    })
    expect(nextStep(cli('claude', installed, { state: 'logged-out' }), null)).toEqual({
      kind: 'login',
      command: 'claude auth login',
    })
    expect(nextStep(cli('codex', installed, { state: 'logged-out' }), null)).toEqual({
      kind: 'login',
      command: 'codex login',
    })
    expect(
      nextStep(cli('codex', installed, { state: 'logged-in', method: 'chatgpt' }), null),
    ).toBeUndefined()
    expect(
      nextStep(cli('codex', installed, { state: 'unknown', problem: 'timeout' }), null),
    ).toBeUndefined()
  })

  it('starts a stopped Ollama and pulls a model it lacks', () => {
    expect(nextStep(ollama({ state: 'stopped' }), null)).toEqual({
      kind: 'serve',
      command: 'ollama serve',
    })
    expect(nextStep(ollama({ state: 'running', version: '0.5.1', models: [] }), null)).toEqual({
      kind: 'pull',
      command: 'ollama pull <model>',
    })
    expect(
      nextStep(
        ollama({ state: 'running', version: '0.5.1', models: ['llama3:latest'] }, true),
        'qwen2.5-coder:7b',
      ),
    ).toEqual({ kind: 'pull', command: 'ollama pull qwen2.5-coder:7b' })
    expect(
      nextStep(
        ollama({ state: 'running', version: '0.5.1', models: ['llama3:latest'] }, true),
        'llama3',
      ),
    ).toBeUndefined()
    expect(
      nextStep(
        ollama({ state: 'running', version: '0.5.1', models: ['llama3:latest'] }),
        'qwen2.5-coder:7b',
      ),
    ).toBeUndefined()
  })
})
