import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  OllamaPullProgress,
  OllamaPullResult,
  ProviderReport,
  ReportedProvider,
} from '../../app/read-provider.js'
import type {
  UserConfigChange,
  UserConfigPlan,
  ValueChange,
} from '../../config/user-config-edit.js'
import {
  CONFIG_FILE,
  frameLines,
  KEYS,
  renderApp,
  visibleWidth,
} from '../../../test/support/tui.js'
import type { AppDeps, HandOffResult, HandOffTarget } from '../app-context.js'

type Setting = 'provider' | 'model'
type Current = Partial<Record<Setting, string>>

const CLAUDE_IN: ReportedProvider = {
  provider: 'claude',
  chosen: false,
  install: { state: 'installed', version: '2.1.3' },
  login: { state: 'logged-in', method: 'claude.ai' },
  next: null,
}
const CLAUDE_OUT: ReportedProvider = {
  ...CLAUDE_IN,
  login: { state: 'logged-out' },
  next: { kind: 'login', command: 'claude auth login' },
}
const CODEX_MISSING: ReportedProvider = {
  provider: 'codex',
  chosen: false,
  install: { state: 'missing' },
  login: { state: 'unknown', problem: 'not-installed' },
  next: { kind: 'install', command: 'npm install -g @openai/codex' },
}
const OLLAMA_STOPPED: ReportedProvider = {
  provider: 'ollama',
  chosen: false,
  baseUrl: 'http://127.0.0.1:11434',
  server: { state: 'stopped' },
  next: { kind: 'serve', command: 'ollama serve' },
}

function ollamaWith(models: string[]): ReportedProvider {
  return {
    provider: 'ollama',
    chosen: false,
    baseUrl: 'http://127.0.0.1:11434',
    server: { state: 'running', version: '0.35.1', models },
    next: models.length === 0 ? { kind: 'pull', command: 'ollama pull <model>' } : null,
  }
}

function report(ollama: ReportedProvider, claude: ReportedProvider = CLAUDE_IN): ProviderReport {
  return {
    choice: { provider: 'claude', model: null, origin: { kind: 'default' } },
    providers: [claude, CODEX_MISSING, ollama],
  }
}

function planOf(changes: readonly UserConfigChange[], current: Current): UserConfigPlan {
  const after: Current = { ...current }
  for (const change of changes) {
    if (change.kind === 'set' && change.key !== 'language') after[change.key] = change.value
    if (change.kind === 'unset' && change.key !== 'language') delete after[change.key]
  }
  const keys: Setting[] = ['provider', 'model']
  const values: ValueChange[] = keys.flatMap((key) =>
    current[key] === after[key]
      ? []
      : [{ key, before: current[key] ?? null, after: after[key] ?? null }],
  )
  return {
    path: CONFIG_FILE,
    exists: Object.keys(current).length > 0,
    before: null,
    text: '',
    changes: values,
  }
}

function controlledPull() {
  const models: string[] = []
  let report: (progress: OllamaPullProgress) => void = () => {}
  let finish: (result: OllamaPullResult) => void = () => {}
  const pullModel: AppDeps['pullModel'] = (model, { signal, onProgress }) => {
    models.push(model)
    report = onProgress
    return new Promise((resolve) => {
      finish = resolve
      signal.addEventListener('abort', () => resolve({ kind: 'cancelled' }), { once: true })
    })
  }
  return {
    pullModel,
    models,
    progress: (progress: OllamaPullProgress) => report(progress),
    finish: (result: OllamaPullResult) => finish(result),
  }
}

function openAiStep(
  options: {
    reports?: ProviderReport[]
    current?: Current
    handOff?: HandOffResult
    pullModel?: AppDeps['pullModel']
    language?: string
  } = {},
) {
  const reports = [...(options.reports ?? [report(OLLAMA_STOPPED)])]
  const current = options.current ?? {}
  const handOffs: HandOffTarget[] = []
  const plans: (readonly UserConfigChange[])[] = []
  const writes: UserConfigPlan[] = []
  const app = renderApp({
    deps: {
      start: 'setup',
      readProviders: async () =>
        (reports.length > 1 ? reports.shift() : reports[0]) ?? report(OLLAMA_STOPPED),
      handOff: async (target) => {
        handOffs.push(target)
        return options.handOff ?? { kind: 'exited', exitCode: 0 }
      },
      planConfig: async (changes) => {
        plans.push(changes)
        return { ok: true, plan: planOf(changes, current) }
      },
      applyConfig: async (plan) => {
        writes.push(plan)
        return { ok: true, written: true }
      },
      ...(options.pullModel === undefined ? {} : { pullModel: options.pullModel }),
      ...(options.language === undefined ? {} : { language: options.language }),
    },
    size: { columns: 80, rows: 24 },
  })
  const seeing = async (...expected: (string | RegExp)[]) => {
    await app.showing(...expected)
    for (const text of expected) expect(app.frame()).toMatch(text)
  }
  const reach = async () => {
    await app.until(() => / 1 (of|de) 7 · GitHub/.test(app.frame()))
    expect(app.frame()).toMatch(/ 1 (of|de) 7 · GitHub/)
    await app.press('s')
    await seeing(/ 2 (of|de) 7 · (AI|IA)/)
  }
  return { ...app, seeing, reach, handOffs, plans, writes }
}

function expectFits(frame: string) {
  const lines = frameLines(frame)
  expect(lines.length).toBeLessThanOrEqual(24)
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80)
}

afterEach(() => cleanup())

describe('the AI step', () => {
  it('shows each AI as checked, with what to do for the ones not ready', async () => {
    const { frame, footer, reach, seeing } = openAiStep()
    await reach()
    await seeing('Claude Code', '2.1.3 · logged in (claude.ai)', 'Codex', 'not installed')
    expect(frame()).toContain('install it with npm install -g @openai/codex')
    expect(frame()).toContain('not running · http://127.0.0.1:11434')
    expect(frame()).toContain('start it with ollama serve')
    expect(footer()).toContain('Enter choose')
    expectFits(frame())
  })

  it("writes the provider with the CLI's default model after its before and after", async () => {
    const { footer, frame, press, reach, seeing, plans, writes } = openAiStep()
    await reach()
    await seeing('logged in (claude.ai)')
    await press(KEYS.enter)
    await seeing('Model for Claude Code', "The CLI's default model")
    await press(KEYS.enter)
    await seeing('Create ~/.config/phada/config.yml?')
    expect(frame()).toMatch(/provider +\(not set\) → claude/)
    expect(footer()).toContain('Enter save')
    expectFits(frame())
    await press(KEYS.enter)
    await seeing(/Step 3 of 7 · Language/)
    expect(plans).toEqual([
      [
        { kind: 'set', key: 'provider', value: 'claude' },
        { kind: 'unset', key: 'model' },
      ],
    ])
    expect(writes).toHaveLength(1)
  })

  it('takes the model out of the config when the default of the CLI is chosen', async () => {
    const { frame, press, reach, seeing } = openAiStep({
      current: { provider: 'codex', model: 'gpt-5-codex' },
    })
    await reach()
    await seeing('logged in (claude.ai)')
    await press(KEYS.enter, KEYS.enter)
    await seeing('Save to ~/.config/phada/config.yml?')
    expect(frame()).toMatch(/provider +codex → claude/)
    expect(frame()).toMatch(/model +gpt-5-codex → \(not set\)/)
  })

  it('writes a model typed for an AI CLI', async () => {
    const { frame, footer, press, reach, seeing, type, plans } = openAiStep()
    await reach()
    await seeing('logged in (claude.ai)')
    await press(KEYS.enter)
    await seeing('Type a model name')
    await press(KEYS.down, KEYS.enter)
    await seeing('Model:')
    expect(footer()).toContain('Enter apply')
    expect(footer()).not.toContain('s skip')
    await type('opus')
    await press(KEYS.enter)
    await seeing(/model +\(not set\) → opus/)
    expect(frame()).toMatch(/provider +\(not set\) → claude/)
    expect(plans).toEqual([
      [
        { kind: 'set', key: 'provider', value: 'claude' },
        { kind: 'set', key: 'model', value: 'opus' },
      ],
    ])
  })

  it('goes back from the models to the AIs on Esc, staying in the setup', async () => {
    const { footer, press, reach, seeing, frame } = openAiStep()
    await reach()
    await seeing('logged in (claude.ai)')
    await press(KEYS.enter)
    await seeing('Model for Claude Code')
    expect(footer()).toContain('Esc back')
    await press(KEYS.escape)
    await seeing('start it with ollama serve')
    expect(frame()).not.toContain('Model for Claude Code')
    expect(frame()).not.toContain('Leave the setup?')
  })

  it('hands the terminal to the login of a logged-out CLI and checks it again on return', async () => {
    const { footer, press, reach, seeing, handOffs } = openAiStep({
      reports: [report(OLLAMA_STOPPED, CLAUDE_OUT), report(OLLAMA_STOPPED)],
    })
    await reach()
    await seeing('logged out', 'log in with claude auth login')
    expect(footer()).toContain('Enter log in to Claude Code')
    await press(KEYS.enter)
    await seeing('logged in (claude.ai)')
    expect(handOffs).toEqual([{ kind: 'ai-login', provider: 'claude' }])
    expect(footer()).toContain('Enter choose')
    await press(KEYS.enter)
    await seeing('Model for Claude Code')
  })

  it('says a login that did not complete and stays usable', async () => {
    const { press, reach, seeing, handOffs } = openAiStep({
      reports: [report(OLLAMA_STOPPED, CLAUDE_OUT)],
      handOff: { kind: 'exited', exitCode: 130 },
    })
    await reach()
    await seeing('logged out')
    await press(KEYS.enter)
    await seeing('Claude Code login not completed.')
    await press(KEYS.enter)
    await seeing('Claude Code login not completed.')
    expect(handOffs).toHaveLength(2)
  })

  it('chooses nothing for an AI CLI that is not installed', async () => {
    const { footer, press, reach, seeing, plans, frame } = openAiStep()
    await reach()
    await seeing('not installed')
    await press(KEYS.down)
    await seeing(/❯ . Codex/)
    expect(footer()).not.toContain('Enter')
    await press(KEYS.enter)
    expect(frame()).not.toContain('Model for Codex')
    expect(plans).toEqual([])
  })

  it('explains a stopped Ollama and checks it again on r', async () => {
    const { footer, press, reach, seeing } = openAiStep({
      reports: [report(OLLAMA_STOPPED), report(ollamaWith(['llama3.1:8b']))],
    })
    await reach()
    await seeing('start it with ollama serve')
    await press(KEYS.down, KEYS.down)
    await seeing('Start Ollama in another terminal, then press r to check again.')
    expect(footer()).toContain('r refresh')
    await press('r')
    await seeing('running 0.35.1')
    await press(KEYS.enter)
    await seeing('Model for Ollama', 'llama3.1:8b')
  })

  it('pulls the suggested model with its progress, then writes it', async () => {
    const pull = controlledPull()
    const { footer, frame, press, reach, seeing, plans, writes } = openAiStep({
      reports: [report(ollamaWith([])), report(ollamaWith(['qwen2.5-coder:7b']))],
      pullModel: pull.pullModel,
    })
    await reach()
    await seeing('no models')
    await press(KEYS.down, KEYS.down, KEYS.enter)
    await seeing('qwen2.5-coder:7b', 'suggested · pulled first, about 4.7 GB')
    expect(footer()).toContain('Enter pull')
    await press(KEYS.enter)
    await seeing('Pulling qwen2.5-coder:7b…')
    pull.progress({
      status: 'pulling 60e05f210007',
      completed: 1_170_800_000,
      total: 4_683_087_332,
    })
    await seeing('1.2 GB of 4.7 GB · 25%', 'pulling 60e05f210007')
    expect(footer()).toContain('Esc cancel the pull')
    expectFits(frame())
    pull.finish({ kind: 'pulled' })
    await seeing(/model +\(not set\) → qwen2\.5-coder:7b/)
    expect(frame()).toMatch(/provider +\(not set\) → ollama/)
    expect(pull.models).toEqual(['qwen2.5-coder:7b'])
    expect(plans).toEqual([
      [
        { kind: 'set', key: 'provider', value: 'ollama' },
        { kind: 'set', key: 'model', value: 'qwen2.5-coder:7b' },
      ],
    ])
    await press(KEYS.enter)
    await seeing(/Step 3 of 7 · Language/)
    expect(writes).toHaveLength(1)
  })

  it('cancels a pull on Esc, staying on the models', async () => {
    const pull = controlledPull()
    const { press, reach, seeing, frame, plans } = openAiStep({
      reports: [report(ollamaWith([]))],
      pullModel: pull.pullModel,
    })
    await reach()
    await seeing('no models')
    await press(KEYS.down, KEYS.down, KEYS.enter, KEYS.enter)
    await seeing('Pulling qwen2.5-coder:7b…')
    await press(KEYS.escape)
    await seeing('Pull of qwen2.5-coder:7b cancelled.')
    expect(frame()).toContain('Model for Ollama')
    expect(frame()).not.toContain('Leave the setup?')
    expect(plans).toEqual([])
  })

  it('shows the error of a pull that failed', async () => {
    const pull = controlledPull()
    const { press, reach, seeing } = openAiStep({
      reports: [report(ollamaWith([]))],
      pullModel: pull.pullModel,
    })
    await reach()
    await seeing('no models')
    await press(KEYS.down, KEYS.down, KEYS.enter, KEYS.enter)
    await seeing('Pulling qwen2.5-coder:7b…')
    pull.finish({ kind: 'failed', message: 'pull model manifest: file does not exist' })
    await seeing('Could not pull qwen2.5-coder:7b: pull model manifest: file does not exist')
  })

  it('writes an installed model of Ollama without pulling it', async () => {
    const pull = controlledPull()
    const { press, reach, seeing, plans } = openAiStep({
      reports: [report(ollamaWith(['llama3.1:8b', 'qwen2.5-coder:7b']))],
      pullModel: pull.pullModel,
    })
    await reach()
    await seeing('2 models')
    await press(KEYS.down, KEYS.down, KEYS.enter)
    await seeing('Model for Ollama', 'llama3.1:8b')
    await press(KEYS.down, KEYS.enter)
    await seeing(/model +\(not set\) → qwen2\.5-coder:7b/)
    expect(pull.models).toEqual([])
    expect(plans).toEqual([
      [
        { kind: 'set', key: 'provider', value: 'ollama' },
        { kind: 'set', key: 'model', value: 'qwen2.5-coder:7b' },
      ],
    ])
  })

  it('pulls a typed model Ollama does not have', async () => {
    const pull = controlledPull()
    const { press, reach, seeing, type } = openAiStep({
      reports: [report(ollamaWith(['llama3.1:8b']))],
      pullModel: pull.pullModel,
    })
    await reach()
    await seeing('1 model')
    await press(KEYS.down, KEYS.down, KEYS.enter)
    await seeing('Type a model name')
    await press(KEYS.down, KEYS.enter)
    await seeing('Model:')
    await type('phi3:mini')
    await press(KEYS.enter)
    await seeing('Pulling phi3:mini…')
    expect(pull.models).toEqual(['phi3:mini'])
  })

  it.each([
    ['pt', 'Modelo do Ollama', 'baixado antes, cerca de 4.7 GB'],
    ['es', 'Modelo de Ollama', 'se descarga antes, unos 4.7 GB'],
  ])('speaks %s and fits 80×24', async (language, title, suggestion) => {
    const { frame, press, reach, seeing } = openAiStep({
      reports: [report(ollamaWith([]))],
      language,
    })
    await reach()
    await press(KEYS.down, KEYS.down, KEYS.enter)
    await seeing(title, suggestion)
    expectFits(frame())
  })
})
