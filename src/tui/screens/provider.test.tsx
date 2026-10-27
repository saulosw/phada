import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderReport, ProviderSetup, ReportedProvider } from '../../app/read-provider.js'
import type {
  SettingKey,
  UserConfigChange,
  UserConfigPlan,
  ValueChange,
} from '../../config/user-config-edit.js'
import type { HandOffResult, HandOffTarget } from '../app-context.js'
import { frameLines, KEYS, renderApp, visibleWidth, waitFor } from '../../../test/support/tui.js'
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
    handOff?: (target: HandOffTarget) => Promise<HandOffResult>
  } = {},
) {
  return renderApp({
    deps: {
      readProviderSetup: options.setup ?? (async () => setup()),
      readProviders: options.providers ?? (async () => report([claude(), codex(), ollama()])),
      ...(options.handOff === undefined ? {} : { handOff: options.handOff }),
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
    const { frame, showing } = openProvider()
    await showing('Reviews with Claude Code · model opus', 'MCP servers (3)', '2 models: qwen2.5')
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
    const { frame, showing } = openProvider({
      setup: async () =>
        setup({
          choice: { provider: 'claude', model: null, origin: { kind: 'default' } },
          mcp: [],
        }),
    })
    await showing("Reviews with Claude Code · the AI CLI's default model", 'Codex')
    expect(frame()).toContain("Reviews with Claude Code · the AI CLI's default model")
    expect(frame()).toContain("Phada's default: your config does not choose a provider")
    expect(frame()).toContain('No MCP servers in your config')
  })

  it('gives the command for a logged-out CLI, a missing one and a stopped Ollama', async () => {
    const { frame, showing } = openProvider({
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
    await showing('Reviews with Claude Code', '→ start it with ollama serve')
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
    const { frame, showing } = openProvider({
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
    await showing('Reviews with Claude Code', '→ pull a model with ollama pull <model>')
    const text = frame()
    expect(row(text, 'Claude Code')).toMatch(
      /\? Claude Code\s+chosen\s+2\.1\.0 · login unknown: no answer in 5 s/,
    )
    expect(row(text, 'Codex')).toContain('version unknown: the check failed')
    expect(row(text, 'Ollama')).toMatch(/○ Ollama\s+running · no models/)
    expect(text).toContain('→ pull a model with ollama pull <model>')
  })

  it('says it is checking, then checks again with r keeping the last result meanwhile', async () => {
    let checks = 0
    let finish: (value: ProviderReport) => void = () => {}
    const { frame, press, showing } = openProvider({
      providers: () => {
        checks++
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    })
    await showing('Reviews with Claude Code', 'Checking…')
    expect(checks).toBe(1)
    expect(frame()).toContain('Reviews with Claude Code')
    expect(frame()).toContain('Checking…')
    finish(report([claude(), codex(), ollama()]))
    await showing('logged in (claude.ai)')
    expect(frame()).not.toContain('Checking…')
    expect(frame()).toContain('logged in (claude.ai)')
    await press('r')
    await waitFor(() => checks === 2)
    expect(checks).toBe(2)
    expect(frame()).toContain('logged in (claude.ai)')
    expect(frame()).not.toContain('Checking…')
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
    await showing('claude auth login')
    expect(frame()).toContain('claude auth login')
  })

  it('shows a failed check and a config it cannot read on the screen', async () => {
    const { frame, showing } = openProvider({
      setup: async () => {
        throw new Error('Invalid config /home/ana/.config/phada/config.yml: provider')
      },
      providers: async () => {
        throw new Error('spawn failed')
      },
    })
    await showing('Could not load: Invalid config', 'Could not load: spawn failed')
    expect(frame()).toContain('Could not load: Invalid config')
    expect(frame()).toContain('Could not load: spawn failed')
  })

  it('draws an error and the model names it read on one line, without control characters', async () => {
    const { frame, showing } = openProvider({
      setup: async () => {
        throw new Error('Invalid config:\n  provider\u001B[2J\u202Eollama')
      },
      providers: async () => {
        throw new Error('spawn failed:\n\u001B]0;title\u0007done')
      },
    })
    await showing('Could not load: Invalid config', 'Could not load: spawn failed')
    expect(frame()).toContain('Could not load: Invalid config: provider[2Jollama')
    expect(frame()).toContain('Could not load: spawn failed: ]0;titledone')
    expect(frame()).not.toMatch(/[\u0007\u202E]|\u001B\[2J|\u001B\]/)
  })

  describe('logging in to an AI CLI', () => {
    const loggedOut = (provider: typeof claude) =>
      provider({
        login: { state: 'logged-out' },
        next: {
          kind: 'login',
          command: provider === claude ? 'claude auth login' : 'codex login',
        },
      })

    function loginFlow(result: HandOffResult | Error, reports: ProviderReport[]) {
      const targets: HandOffTarget[] = []
      let checks = 0
      const opened = openProvider({
        providers: async () => reports[Math.min(checks++, reports.length - 1)] as ProviderReport,
        handOff: async (target) => {
          targets.push(target)
          if (result instanceof Error) throw result
          return result
        },
      })
      return { ...opened, targets, checks: () => checks }
    }

    it('hands the terminal to the login of the chosen CLI with l and shows it logged in on return', async () => {
      const { frame, footer, press, showing, targets, checks } = loginFlow(
        { kind: 'exited', exitCode: 0 },
        [report([loggedOut(claude), codex(), ollama()]), report([claude(), codex(), ollama()])],
      )
      await showing('→ log in with claude auth login')
      expect(footer()).toContain('l log in to Claude Code')
      await press('l')
      await showing('logged in (claude.ai)')
      expect(targets).toEqual([{ kind: 'ai-login', provider: 'claude' }])
      expect(checks()).toBe(2)
      expect(frame()).not.toContain('claude auth login')
      expect(frame()).not.toContain('not completed')
      expectFits(frame(), { columns: 80, rows: 24 })
    })

    it('logs in again to the chosen CLI when it is logged in', async () => {
      const { footer, press, showing, targets } = loginFlow({ kind: 'exited', exitCode: 0 }, [
        report([claude(), loggedOut(codex), ollama()]),
      ])
      await showing('→ log in with codex login')
      expect(footer()).toContain('l log in to Claude Code')
      await press('l')
      await waitFor(() => targets.length === 1)
      expect(targets).toEqual([{ kind: 'ai-login', provider: 'claude' }])
    })

    it('offers no login when the chosen AI is Ollama and every CLI is logged in or missing', async () => {
      const { footer, showing } = loginFlow({ kind: 'exited', exitCode: 0 }, [
        report([
          claude({ chosen: false }),
          codex({ install: { state: 'missing' } }),
          ollama({ chosen: true }),
        ]),
      ])
      await showing('logged in (claude.ai)')
      expect(footer()).not.toContain('log in to')
    })

    it('logs in to Codex when the chosen AI is Ollama and Codex is the CLI logged out', async () => {
      const { footer, press, showing, targets } = loginFlow({ kind: 'exited', exitCode: 0 }, [
        report([claude({ chosen: false }), loggedOut(codex), ollama({ chosen: true })]),
      ])
      await showing('→ log in with codex login')
      expect(footer()).toContain('l log in to Codex')
      await press('l')
      await waitFor(() => targets.length === 1)
      expect(targets).toEqual([{ kind: 'ai-login', provider: 'codex' }])
    })

    it('says the login was not completed when it ends with an error, checks again and keeps working', async () => {
      const { frame, press, showing, targets, checks } = loginFlow(
        { kind: 'exited', exitCode: 130 },
        [report([loggedOut(claude), codex(), ollama()])],
      )
      await showing('→ log in with claude auth login')
      await press('l')
      await showing('Claude Code login not completed.')
      expect(frame()).toContain('Claude Code login not completed.')
      expect(checks()).toBe(2)
      expect(frame()).toContain('→ log in with claude auth login')
      expectFits(frame(), { columns: 80, rows: 24 })
      await press('l')
      await waitFor(() => targets.length === 2)
      expect(targets).toHaveLength(2)
    })

    it('says the login was not completed when the CLI ends with 0 but is still logged out', async () => {
      const { frame, press, showing, checks } = loginFlow({ kind: 'exited', exitCode: 0 }, [
        report([claude({ chosen: false }), loggedOut(codex), ollama({ chosen: true })]),
      ])
      await showing('→ log in with codex login')
      await press('l')
      await showing('Codex login not completed.')
      expect(frame()).toContain('Codex login not completed.')
      expect(checks()).toBe(2)
      expect(frame()).toContain('→ log in with codex login')
      expectFits(frame(), { columns: 80, rows: 24 })
    })

    it('names a login command it could not find', async () => {
      const { frame, press, showing } = loginFlow({ kind: 'not-found', command: 'claude' }, [
        report([loggedOut(claude), codex(), ollama()]),
      ])
      await showing('→ log in with claude auth login')
      await press('l')
      await showing('claude was not found.')
      expect(frame()).toContain('claude was not found.')
      expect(frame()).not.toContain('not completed')
    })

    it('shows a hand-off that failed on one line', async () => {
      const { frame, press, showing } = loginFlow(new Error('spawn EACCES\nclaude'), [
        report([loggedOut(claude), codex(), ollama()]),
      ])
      await showing('→ log in with claude auth login')
      await press('l')
      await showing('Could not run: spawn EACCES claude')
      expect(frame()).toContain('Could not run: spawn EACCES claude')
    })
  })

  it('fits a wide terminal', async () => {
    const size = { columns: 160, rows: 40 }
    const { frame, showing } = openProvider({ size })
    await showing('repos/<owner>/<repo>/config.yml of your config folder', 'Ollama')
    expectFits(frame(), size)
    expect(frame()).toContain(
      'repos/<owner>/<repo>/config.yml of your config folder or in its .phada/config.yml',
    )
  })

  it('is translated', async () => {
    const { frame, showing } = openProvider({
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
    await showing('Revisa com Claude Code · modelo opus', '→ faça login com claude auth login')
    expect(frame()).toContain('Revisa com Claude Code · modelo opus')
    expect(frame()).toContain('→ faça login com claude auth login')
    expect(frame()).toContain('Servidores MCP (3)')
  })

  describe('changing the AI and the language', () => {
    type Current = Partial<Record<SettingKey, string>>

    function planOf(changes: readonly UserConfigChange[], current: Current): UserConfigPlan {
      const values: Extract<ValueChange, { key: SettingKey }>[] = changes.flatMap((change) =>
        change.kind === 'set' || change.kind === 'unset'
          ? [
              {
                key: change.key,
                before: current[change.key] ?? null,
                after: change.kind === 'set' ? change.value : null,
              },
            ]
          : [],
      )
      return {
        path: CONFIG,
        exists: true,
        before: '# my notes\n',
        text: '# my notes\n',
        changes: values.filter(({ before, after }) => before !== after),
      }
    }

    function openEditable(options: { invalid?: boolean; language?: string } = {}) {
      const current: Current = {
        provider: 'claude',
        model: 'opus',
        ...(options.language === undefined ? {} : { language: options.language }),
      }
      const writes: UserConfigPlan[] = []
      let checks = 0
      const choice = () => ({
        provider: (current.provider ?? 'claude') as 'claude' | 'codex',
        model: current.model ?? null,
        origin: { kind: 'user-config' as const, path: CONFIG },
      })
      const app = renderApp({
        deps: {
          readProviderSetup: async () => {
            if (options.invalid === true) {
              throw new Error('Invalid config /home/ana/.config/phada/config.yml: watch')
            }
            return setup({ choice: choice(), mcp: [] })
          },
          readProviders: async () => {
            checks++
            return {
              choice: choice(),
              providers: [
                claude({ chosen: current.provider === 'claude' }),
                codex({ chosen: current.provider === 'codex' }),
                ollama(),
              ],
            }
          },
          readLanguage: async () => current.language,
          ...(options.language === undefined ? {} : { language: options.language }),
          planConfig: async (changes) => ({ ok: true, plan: planOf(changes, current) }),
          applyConfig: async (plan) => {
            writes.push(plan)
            for (const change of plan.changes) {
              if (change.key === 'watch.repos' || change.key === 'publish') continue
              if (change.after === null) delete current[change.key]
              else current[change.key] = change.after
            }
            return { ok: true, written: true }
          },
        },
        size: { columns: 80, rows: 24 },
        screens: [{ id: 'provider', title: (m) => m.screens.provider, Screen: ProviderScreen }],
      })
      return { ...app, writes, checks: () => checks }
    }

    it('changes the provider and model with c, after their before and after, and shows them on return', async () => {
      const { checks, exits, footer, frame, press, showing, until, writes } = openEditable()
      await showing('Reviews with Claude Code · model opus', 'logged in (chatgpt)')
      expect(footer()).toContain('c change the AI')
      await press('c')
      await showing('Choose the AI that reviews', '❯ ● Claude Code')
      expect(footer()).toContain('Esc back')
      await press(KEYS.down, KEYS.enter)
      await showing('Model for Codex')
      await press(KEYS.enter)
      await showing('Save ~/.config/phada/config.yml?')
      expect(frame()).toMatch(/provider +claude → codex/)
      expect(frame()).toMatch(/model +opus → \(not set\)/)
      expectFits(frame(), { columns: 80, rows: 24 })
      const before = checks()
      await press(KEYS.enter)
      await showing("Reviews with Codex · the AI CLI's default model")
      await until(() => checks() > before)
      expect(row(frame(), 'Codex')).toMatch(/Codex\s+chosen/)
      expect(writes).toHaveLength(1)
      expect(exits).toEqual([])
    })

    it('leaves the change with Esc without writing', async () => {
      const { exits, frame, press, showing, writes } = openEditable()
      await showing('Reviews with Claude Code · model opus', 'logged in (chatgpt)')
      await press('c')
      await showing('Choose the AI that reviews')
      await press(KEYS.down, KEYS.enter)
      await showing('Model for Codex')
      await press(KEYS.enter)
      await showing('claude → codex')
      await press(KEYS.escape)
      await showing('Model for Codex')
      expect(frame()).not.toContain('claude → codex')
      await press(KEYS.escape)
      await showing('Choose the AI that reviews')
      await press(KEYS.escape)
      await showing('Reviews with Claude Code · model opus', 'MCP')
      expect(writes).toEqual([])
      expect(exits).toEqual([])
    })

    it('changes the language with L and speaks it at once', async () => {
      const { footer, frame, press, showing, writes } = openEditable()
      await showing('Language: English', 'logged in (chatgpt)')
      expect(footer()).toContain('L language')
      await press('L')
      await showing('❯ English', 'Português')
      await press(KEYS.down, KEYS.enter)
      await showing('Save ~/.config/phada/config.yml?')
      expect(frame()).toMatch(/language +\(not set\) → pt/)
      await press(KEYS.enter)
      await showing('Idioma: Português', 'Revisa com Claude Code')
      expect(writes).toHaveLength(1)
      expectFits(frame(), { columns: 80, rows: 24 })
    })

    it('goes back without writing when the language picked is the current one, or on Esc', async () => {
      const { exits, press, showing, writes } = openEditable({ language: 'pt-BR' })
      await showing('Idioma: Português', 'Revisa com')
      await press('L')
      await showing('❯ Português')
      await press(KEYS.enter)
      await showing('Idioma: Português', 'Revisa com')
      await press('L')
      await showing('❯ Português')
      await press(KEYS.escape)
      await showing('Idioma: Português', 'Revisa com')
      expect(writes).toEqual([])
      expect(exits).toEqual([])
    })

    it('offers no change while the config is invalid', async () => {
      const { footer, frame, press, showing, writes } = openEditable({ invalid: true })
      await showing('Could not load: Invalid config', 'logged in (chatgpt)')
      expect(footer()).not.toContain('change the AI')
      expect(footer()).not.toContain('language')
      await press('c', 'L')
      await showing('Could not load: Invalid config')
      expect(frame()).not.toContain('Choose the AI that reviews')
      expect(frame()).not.toContain('Português')
      expect(writes).toEqual([])
    })
  })
})
