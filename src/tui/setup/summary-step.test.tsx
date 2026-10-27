import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { UserConfigChange, UserConfigPlan } from '../../config/user-config-edit.js'
import { frameLines, KEYS, renderApp, visibleWidth } from '../../../test/support/tui.js'

const CONFIG = '/home/ana/.config/phada/config.yml'

function openSetup(language?: string) {
  let current = language
  const app = renderApp({
    deps: {
      start: 'setup',
      ...(language === undefined ? {} : { language }),
      readLanguage: async () => current,
      planConfig: async (changes: readonly UserConfigChange[]) => {
        const [change] = changes
        const value = change?.kind === 'set' ? change.value : ''
        const plan: UserConfigPlan = {
          path: CONFIG,
          exists: true,
          before: `language: ${current}\n`,
          text: `language: ${value}\n`,
          changes: [{ key: 'language', before: current ?? null, after: value }],
        }
        return { ok: true, plan }
      },
      applyConfig: async (plan) => {
        const [change] = plan.changes
        if (change?.key === 'language') current = change.after ?? undefined
        return { ok: true, written: true }
      },
    },
    size: { columns: 80, rows: 24 },
  })
  const seeing = async (...expected: (string | RegExp)[]) => {
    await app.showing(...expected)
    for (const text of expected) expect(app.frame()).toMatch(text)
  }
  return { ...app, seeing }
}

function expectFits(frame: string) {
  const lines = frameLines(frame)
  expect(lines.length).toBeLessThanOrEqual(24)
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80)
}

afterEach(() => cleanup())

describe('the summary', () => {
  it('says what was written and where, what was skipped and what to do now', async () => {
    const { footer, frame, press, seeing } = openSetup('pt')
    await seeing(/ 1 de 7 · GitHub/)
    await press('s', 's', KEYS.up, KEYS.enter)
    await seeing('Gravar em ~/.config/phada/config.yml?')
    await press(KEYS.enter)
    await seeing('Step 4 of 7')
    await press('s', 's', 's')
    await seeing('Step 7 of 7 · Summary', 'Written to ~/.config/phada/config.yml')
    expect(frame()).toMatch(/language +pt → en/)
    expect(frame()).toContain('Skipped: GitHub, AI, Repositories, Graph, This repository')
    expect(frame()).toContain('phada watch')
    expect(frame()).toContain('phada review owner/repo#N')
    expect(footer()).toContain('Enter go to Home')
    expect(footer()).not.toContain('s skip')
    expectFits(frame())
    await press(KEYS.enter)
    await seeing('Last reviews')
    expect(frame()).not.toContain('Summary')
  })

  it('says nothing was written when every step was skipped', async () => {
    const { frame, press, seeing } = openSetup()
    await seeing('Step 1 of 7')
    await press('s', 's', 's', 's', 's', 's')
    await seeing('Step 7 of 7 · Summary', 'Nothing was written to your config.')
    expect(frame()).toContain('Skipped: GitHub, AI, Language, Repositories, Graph, This repository')
    await press('s')
    await seeing('Step 7 of 7 · Summary')
  })

  it.each([
    ['pt', 'Nada foi gravado na sua config.', 'O que fazer agora'],
    ['es', 'No se guardó nada en tu configuración.', 'Qué hacer ahora'],
  ])('speaks %s', async (language, nothing, now) => {
    const { frame, press, seeing } = openSetup(language)
    await seeing(/ 1 de 7 · GitHub/)
    await press('s', 's', 's', 's', 's', 's')
    await seeing(nothing, now)
    expectFits(frame())
  })
})
