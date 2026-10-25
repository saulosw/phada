import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderReport, ProviderSetup, ReportedProvider } from '../../app/read-provider.js'
import { frameLines, renderApp, settle, visibleWidth } from '../../../test/support/tui.js'
import { SCREENS } from '../screens.js'
import type { TerminalSize } from '../terminal-size.js'
import { ProviderScreen } from './provider.js'

afterEach(() => cleanup())

const CONFIG = '/home/ana/.config/phada/config.yml'

const claude = (
  changes: Partial<Extract<ReportedProvider, { provider: 'claude' | 'codex' }>> = {},
) =>
  ({
    provider: 'claude',
    install: { state: 'installed', version: '2.1.0' },
    login: { state: 'logged-in', method: 'claude.ai' },
    chosen: true,
    next: null,
    ...changes,
  }) as ReportedProvider
const codex = (
  changes: Partial<Extract<ReportedProvider, { provider: 'claude' | 'codex' }>> = {},
) =>
  ({
    provider: 'codex',
    install: { state: 'installed', version: '0.98.0' },
    login: { state: 'logged-in', method: 'chatgpt' },
    chosen: false,
    next: null,
    ...changes,
  }) as ReportedProvider
const ollama = (changes: Partial<Extract<ReportedProvider, { provider: 'ollama' }>> = {}) =>
  ({
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    server: { state: 'running', version: '0.12.3', models: ['qwen2.5-coder:7b', 'llama3:latest'] },
    chosen: false,
    next: null,
    ...changes,
  }) as ReportedProvider

function setup(changes: Partial<ProviderSetup> = {}): ProviderSetup {
  return {
    choice: { provider: 'claude', model: 'opus', origin: { kind: 'user-config', path: CONFIG } },
    mcp: [
      { name: 'github', kind: 'named', tools: [], description: null },
      { name: 'docs', kind: 'command', tools: ['search', 'read'], description: 'Internal docs' },
      { name: 'tracker', kind: 'http', tools: [], description: null },
    ],
    ...changes,
  }
}

function report(providers: ReportedProvider[]): ProviderReport {
  return { choice: setup().choice, providers }
}

function openProvider(
  options: {
    setup?: () => Promise<ProviderSetup>
    providers?: () => Promise<ProviderReport>
    size?: TerminalSize
    language?: string
  } = {},
) {
  return renderApp({
    deps: {
      readProviderSetup: options.setup ?? (async () => setup()),
      readProviders: options.providers ?? (async () => report([claude(), codex(), ollama()])),
      ...(options.language === undefined ? {} : { language: options.language }),
    },
    size: options.size ?? { columns: 80, rows: 24 },
    screens: [{ id: 'provider', title: (m) => m.screens.provider, Screen: ProviderScreen }],
  })
}

function expectFits(frame: string, size: TerminalSize) {
  const lines = frameLines(frame)
  expect(lines).toHaveLength(size.rows)
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(size.columns)
}

const row = (frame: string, name: string) =>
  frameLines(frame).find((line) => line.includes(name) && /[●○?]/.test(line)) ?? ''

describe('the Provider screen', () => {
  it('is the Provider tab of the app', () => {
    expect(SCREENS.find(({ id }) => id === 'provider')?.Screen).toBe(ProviderScreen)
  })

  it('shows the chosen provider and model, where they come from, every AI logged in and the MCP servers in 80×24', async () => {
    const { frame } = openProvider()
    await settle()
    const text = frame()
    expectFits(text, { columns: 80, rows: 24 })
    expect(text).toContain('Reviews with Claude Code · model opus')
    expect(text).toContain('Chosen in ~/.config/phada/config.yml')
    expect(text).toContain('.phada/config.yml')
    expect(row(text, 'Claude Code')).toMatch(
      /● Claude Code\s+chosen\s+2\.1\.0 · logged in \(claude\.ai\)/,
    )
    expect(row(text, 'Codex')).toMatch(/● Codex\s+0\.98\.0 · logged in \(chatgpt\)/)
    expect(row(text, 'Ollama')).toMatch(/● Ollama\s+running 0\.12\.3 · http:\/\/127\.0\.0\.1:11434/)
    expect(text).toContain('2 models: qwen2.5-coder:7b, llama3:latest')
    expect(text).toContain('MCP servers (3)')
    expect(text).toMatch(/github\s+set up in your AI CLI/)
    expect(text).toMatch(/docs\s+started by Phada · tools: search, read · Internal docs/)
    expect(text).toMatch(/tracker\s+over HTTP/)
    expect(text).not.toMatch(/ {4}→ /)
  })

  it("says Phada's default chose the provider and that the CLI picks the model", async () => {
    const { frame } = openProvider({
      setup: async () =>
        setup({
          choice: { provider: 'claude', model: null, origin: { kind: 'default' } },
          mcp: [],
        }),
    })
    await settle()
    expect(frame()).toContain("Reviews with Claude Code · the AI CLI's default model")
    expect(frame()).toContain("Phada's default: your config does not choose a provider")
    expect(frame()).toContain('No MCP servers in your config')
  })

  it('gives the command for a logged-out CLI, a missing one and a stopped Ollama', async () => {
    const { frame } = openProvider({
      providers: async () =>
        report([
          claude({
            login: { state: 'logged-out' },
            next: { kind: 'login', command: 'claude auth login' },
          }),
          codex({
            install: { state: 'missing' },
            login: { state: 'unknown', problem: 'not-installed' },
            next: { kind: 'install', command: 'npm install -g @openai/codex' },
          }),
          ollama({
            server: { state: 'stopped' },
            next: { kind: 'serve', command: 'ollama serve' },
          }),
        ]),
    })
    await settle()
    const text = frame()
    expectFits(text, { columns: 80, rows: 24 })
    expect(row(text, 'Claude Code')).toMatch(/○ Claude Code\s+chosen\s+2\.1\.0 · logged out/)
    expect(text).toContain('→ log in with claude auth login')
    expect(row(text, 'Codex')).toMatch(/○ Codex\s+not installed/)
    expect(text).toContain('→ install it with npm install -g @openai/codex')
    expect(row(text, 'Ollama')).toMatch(/○ Ollama\s+not running · http:\/\/127\.0\.0\.1:11434/)
    expect(text).toContain('→ start it with ollama serve')
  })

  it('asks for a model when Ollama has none and names what went wrong with a check', async () => {
    const { frame } = openProvider({
      providers: async () =>
        report([
          claude({ login: { state: 'unknown', problem: 'timeout' } }),
          codex({
            install: { state: 'unknown', problem: 'failed' },
            login: { state: 'unknown', problem: 'failed' },
          }),
          ollama({
            server: { state: 'running', version: null, models: [] },
            next: { kind: 'pull', command: 'ollama pull <model>' },
          }),
        ]),
    })
    await settle()
    const text = frame()
    expect(row(text, 'Claude Code')).toMatch(
      /\? Claude Code\s+chosen\s+2\.1\.0 · login unknown: no answer in 5 s/,
    )
    expect(row(text, 'Codex')).toContain('version unknown: the check failed')
    expect(row(text, 'Ollama')).toMatch(/○ Ollama\s+running · no models/)
    expect(text).toContain('→ pull a model with ollama pull <model>')
  })

  it('says it is checking, then checks again with r', async () => {
    let checks = 0
    let finish: (value: ProviderReport) => void = () => {}
    const { frame, press } = openProvider({
      providers: () => {
        checks++
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    })
    await settle()
    expect(frame()).toContain('Reviews with Claude Code')
    expect(frame()).toContain('Checking…')
    finish(report([claude(), codex(), ollama()]))
    await settle()
    expect(frame()).not.toContain('Checking…')
    expect(frame()).toContain('logged in (claude.ai)')
    await press('r')
    expect(checks).toBe(2)
    expect(frame()).toContain('Checking…')
    finish(
      report([
        claude({
          login: { state: 'logged-out' },
          next: { kind: 'login', command: 'claude auth login' },
        }),
        codex(),
        ollama(),
      ]),
    )
    await settle()
    expect(frame()).toContain('claude auth login')
  })

  it('shows a failed check and a config it cannot read on the screen', async () => {
    const { frame } = openProvider({
      setup: async () => {
        throw new Error('Invalid config /home/ana/.config/phada/config.yml: provider')
      },
      providers: async () => {
        throw new Error('spawn failed')
      },
    })
    await settle()
    expect(frame()).toContain('Could not load: Invalid config')
    expect(frame()).toContain('Could not load: spawn failed')
  })

  it('draws an error and the model names it read on one line, without control characters', async () => {
    const { frame } = openProvider({
      setup: async () => {
        throw new Error('Invalid config:\n  provider\u001B[2J\u202Eollama')
      },
      providers: async () => {
        throw new Error('spawn failed:\n\u001B]0;title\u0007done')
      },
    })
    await settle()
    expect(frame()).toContain('Could not load: Invalid config: provider[2Jollama')
    expect(frame()).toContain('Could not load: spawn failed: ]0;titledone')
    expect(frame()).not.toMatch(/[\u0007\u202E]|\u001B\[2J|\u001B\]/)
  })

  it('fits a wide terminal', async () => {
    const size = { columns: 160, rows: 40 }
    const { frame } = openProvider({ size })
    await settle()
    expectFits(frame(), size)
    expect(frame()).toContain(
      'repos/<owner>/<repo>/config.yml of your config folder or in its .phada/config.yml',
    )
  })

  it('is translated', async () => {
    const { frame } = openProvider({
      language: 'pt',
      providers: async () =>
        report([
          claude({
            login: { state: 'logged-out' },
            next: { kind: 'login', command: 'claude auth login' },
          }),
          codex(),
          ollama(),
        ]),
    })
    await settle()
    expect(frame()).toContain('Revisa com Claude Code · modelo opus')
    expect(frame()).toContain('→ faça login com claude auth login')
    expect(frame()).toContain('Servidores MCP (3)')
  })
})
