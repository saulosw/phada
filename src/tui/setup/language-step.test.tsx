import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppliedUserConfig, UserConfigPlanResult } from '../../app/edit-user-config.js'
import type { UserConfigChange, UserConfigPlan } from '../../config/user-config-edit.js'
import { frameLines, KEYS, renderApp, visibleWidth } from '../../../test/support/tui.js'

const CONFIG = '/home/ana/.config/phada/config.yml'

function planOf(changes: readonly UserConfigChange[], current: string | undefined): UserConfigPlan {
  const [change] = changes
  const value = change?.kind === 'set' ? change.value : ''
  return {
    path: CONFIG,
    exists: current !== undefined,
    before: current === undefined ? null : `language: ${current}\n`,
    text: `language: ${value}\n`,
    changes: [{ key: 'language', before: current ?? null, after: value }],
  }
}

function openLanguageStep(
  options: {
    language?: string
    invalid?: string
    planned?: UserConfigPlanResult[]
    applied?: AppliedUserConfig[]
  } = {},
) {
  let language = options.language
  const plans: (readonly UserConfigChange[])[] = []
  const writes: UserConfigPlan[] = []
  const planned = [...(options.planned ?? [])]
  const applied = [...(options.applied ?? [])]
  const app = renderApp({
    deps: {
      start: 'setup',
      ...(language === undefined ? {} : { language }),
      readLanguage: async () => {
        if (options.invalid !== undefined) throw new Error(options.invalid)
        return language
      },
      planConfig: async (changes) => {
        plans.push(changes)
        return planned.shift() ?? { ok: true, plan: planOf(changes, language) }
      },
      applyConfig: async (plan) => {
        writes.push(plan)
        const result = applied.shift() ?? { ok: true, written: true }
        const [change] = plan.changes
        if (result.ok && change?.key === 'language') language = change.after ?? undefined
        return result
      },
    },
    size: { columns: 80, rows: 24 },
  })
  const seeing = async (...expected: string[]) => {
    await app.showing(...expected)
    for (const text of expected) expect(app.frame()).toContain(text)
  }
  const reach = async () => {
    await app.until(() => / 1 (of|de) 7 · GitHub/.test(app.frame()))
    expect(app.frame()).toMatch(/ 1 (of|de) 7 · GitHub/)
    await app.press('s', 's')
  }
  return { ...app, seeing, reach, plans, writes }
}

function expectFits(frame: string) {
  const lines = frameLines(frame)
  expect(lines.length).toBeLessThanOrEqual(24)
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80)
}

afterEach(() => cleanup())

describe('the language step', () => {
  it('writes the language after its before and after, and speaks it at once', async () => {
    const { footer, frame, press, reach, seeing, writes } = openLanguageStep()
    await reach()
    await seeing('Step 3 of 7 · Language', 'English', 'Português', 'Español')
    await press(KEYS.down, KEYS.enter)
    await seeing('Create ~/.config/phada/config.yml?')
    expect(frame()).toMatch(/language +\(not set\) → pt/)
    expect(footer()).toContain('Enter save')
    expect(footer()).toContain('Esc cancel')
    expectFits(frame())
    await press(KEYS.enter)
    await seeing('Passo 4 de 7 · Repositórios')
    expect(writes.map(({ text }) => text)).toEqual(['language: pt\n'])
  })

  it('cancels the change on Esc without writing or leaving', async () => {
    const { frame, press, reach, seeing, writes } = openLanguageStep()
    await reach()
    await seeing('Step 3 of 7')
    await press(KEYS.down, KEYS.down, KEYS.enter)
    await seeing('(not set) → es')
    await press(KEYS.escape)
    await seeing('Step 3 of 7')
    expect(frame()).not.toContain('(not set) → es')
    expect(frame()).not.toContain('Leave the setup?')
    expect(writes).toEqual([])
  })

  it('goes on without writing when the language picked is the current one', async () => {
    const { press, reach, seeing, plans, writes } = openLanguageStep({ language: 'pt-BR' })
    await reach()
    await seeing('Passo 3 de 7 · Idioma', '❯ Português')
    await press(KEYS.enter)
    await seeing('Passo 4 de 7')
    expect(plans).toEqual([])
    expect(writes).toEqual([])
  })

  it('shows why the config file cannot be changed', async () => {
    const { press, reach, seeing, writes } = openLanguageStep({
      planned: [{ ok: false, reason: 'invalid-config', message: 'watch.interval: expected 5m' }],
    })
    await reach()
    await seeing('Step 3 of 7')
    await press(KEYS.down, KEYS.enter)
    await seeing('Your config file has an error')
    await seeing('expected 5m')
    await press(KEYS.enter)
    expect(writes).toEqual([])
  })

  it('shows the error of an invalid config instead of the languages, and skips on', async () => {
    const { footer, frame, press, reach, seeing, plans } = openLanguageStep({
      invalid: 'Invalid config /home/ana/.config/phada/config.yml: watch.interval: expected 5m',
    })
    await reach()
    await seeing('Step 3 of 7', 'Could not load: Invalid config', 'expected 5m')
    expect(frame()).not.toContain('Português')
    expect(footer()).not.toContain('Enter')
    await press(KEYS.enter)
    expect(plans).toEqual([])
    await press('s')
    await seeing('Step 4 of 7')
  })

  it('plans again when the file changed since the plan', async () => {
    const { press, reach, seeing, plans, writes } = openLanguageStep({
      applied: [{ ok: false, reason: 'changed' }],
    })
    await reach()
    await seeing('Step 3 of 7')
    await press(KEYS.down, KEYS.enter)
    await seeing('(not set) → pt')
    await press(KEYS.enter)
    await seeing('changed since')
    await press(KEYS.enter)
    await seeing('(not set) → pt')
    expect(plans).toHaveLength(2)
    await press(KEYS.enter)
    await seeing('Passo 4 de 7')
    expect(writes).toHaveLength(2)
  })

  it('shows a failed write in one line and stays', async () => {
    const { press, reach, seeing } = openLanguageStep({
      applied: [{ ok: false, reason: 'failed', message: 'EACCES: permission denied' }],
    })
    await reach()
    await seeing('Step 3 of 7')
    await press(KEYS.down, KEYS.enter)
    await seeing('(not set) → pt')
    await press(KEYS.enter)
    await seeing('Could not write the config file: EACCES: permission denied', 'Step 3 of 7')
  })

  it.each([
    ['pt', 'Passo 3 de 7 · Idioma', 'Gravar em ~/.config/phada/config.yml?'],
    ['es', 'Paso 3 de 7 · Idioma', 'Guardar en ~/.config/phada/config.yml?'],
  ])('speaks %s', async (language, step, save) => {
    const { frame, press, reach, seeing } = openLanguageStep({ language })
    await reach()
    await seeing(step)
    await press(KEYS.up, KEYS.up, KEYS.enter)
    await seeing(save)
    expect(frame()).toMatch(new RegExp(`language +${language} → en`))
    expectFits(frame())
  })
})
