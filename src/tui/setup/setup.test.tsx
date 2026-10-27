import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { frameLines, KEYS, renderApp, visibleWidth } from '../../../test/support/tui.js'
import type { AppDeps } from '../app-context.js'
import type { TerminalSize } from '../terminal-size.js'

const SMALL: TerminalSize = { columns: 80, rows: 24 }

function openSetup(deps: Partial<AppDeps> = {}, size: TerminalSize = SMALL) {
  return withSeeing(renderApp({ deps: { start: 'setup', ...deps }, size }))
}

function withSeeing<T extends ReturnType<typeof renderApp>>(app: T) {
  const seeing = async (...expected: string[]) => {
    await app.showing(...expected)
    for (const text of expected) expect(app.frame()).toContain(text)
  }
  return { ...app, seeing }
}

function expectFits(frame: string) {
  const lines = frameLines(frame)
  expect(lines.length).toBeLessThanOrEqual(SMALL.rows)
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(SMALL.columns)
}

afterEach(() => cleanup())

describe('the setup', () => {
  it('opens on its first step, outside the tabs', async () => {
    const { frame, footer, seeing } = openSetup()
    await seeing('Step 1 of 7 · GitHub')
    expect(frame()).not.toContain('Repositories')
    expect(footer()).toContain('s skip')
    expect(footer()).toContain('Esc leave')
    expectFits(frame())
  })

  it('skips each step with s, up to the summary', async () => {
    const { frame, press, seeing } = openSetup()
    await seeing('Step 1 of 7')
    for (const [step, title] of [
      [2, 'AI'],
      [3, 'Language'],
      [4, 'Repositories'],
      [5, 'Graph'],
      [6, 'This repository'],
      [7, 'Summary'],
    ] as const) {
      await press('s')
      await seeing(`Step ${step} of 7 · ${title}`)
      expectFits(frame())
    }
  })

  it('asks before leaving, and stays on n or Esc', async () => {
    const { frame, press, seeing, footer } = openSetup()
    await seeing('Step 1 of 7')
    await press('s', KEYS.escape)
    await seeing('Leave the setup?')
    expect(footer()).toContain('y/Enter leave')
    await press('n')
    await seeing('Step 2 of 7')
    expect(frame()).not.toContain('Leave the setup?')
    await press(KEYS.escape)
    await seeing('Leave the setup?')
    await press(KEYS.escape)
    await seeing('Step 2 of 7')
    expect(frame()).not.toContain('Leave the setup?')
  })

  it.each([['y'], [KEYS.enter]])('leaves to the Home on %j', async (key) => {
    const { frame, press, seeing, exits } = openSetup()
    await seeing('Step 1 of 7')
    await press(KEYS.escape)
    await seeing('Leave the setup?')
    await press(key)
    await seeing('Repositories', 'Last reviews')
    expect(frame()).not.toContain('Step 1 of 7')
    expect(exits).toEqual([])
  })

  it('opens again from the palette with /setup', async () => {
    const { frame, press, seeing, type } = withSeeing(renderApp({ size: SMALL }))
    await seeing('Last reviews')
    await press('/')
    await type('setup')
    await seeing('❯ Setup')
    await press(KEYS.enter)
    await seeing('Step 1 of 7 · GitHub')
    expect(frame()).not.toContain('Repositories')
  })

  it('leaves to a screen picked in the palette', async () => {
    const { frame, press, seeing, type } = openSetup()
    await seeing('Step 1 of 7')
    await press('/')
    await type('queue')
    await press(KEYS.enter)
    await seeing('No watch has run here yet.')
    expect(frame()).toContain('No watch has run here yet.')
    expect(frame()).not.toContain('Step 1 of 7')
  })

  it.each([
    ['pt', 'Passo 1 de 7 · GitHub', 's pular'],
    ['es', 'Paso 1 de 7 · GitHub', 's omitir'],
  ])('speaks %s', async (language, step, skip) => {
    const { frame, footer, seeing } = openSetup({ language })
    await seeing(step)
    expect(footer()).toContain(skip)
    expectFits(frame())
  })
})
