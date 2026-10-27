import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Text } from 'ink'
import { cleanup } from 'ink-testing-library'
import { useState } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { KEYS, renderApp, waitFor } from '../../test/support/tui.js'
import { useBack, useScreenInput, useScreenKeys, useWorking } from './app-context.js'
import type { AppDeps } from './app-context.js'
import { SCREENS } from './screens.js'
import type { ScreenDefinition } from './screens.js'
import { FLAP_MS, Mascot, MASCOT_FRAMES } from './mascot.js'
import type { TerminalSize } from './terminal-size.js'

const inkChalk = await chalkOfInk()

async function chalkOfInk(): Promise<{ level: number }> {
  const ink = createRequire(import.meta.url).resolve('ink')
  const chalk = createRequire(ink).resolve('chalk')
  const loaded = (await import(pathToFileURL(chalk).href)) as { default: { level: number } }
  return loaded.default
}

function openApp(
  options: {
    language?: string
    env?: AppDeps['env']
    size?: TerminalSize
    screens?: readonly ScreenDefinition[]
  } = {},
) {
  return renderApp({
    deps: {
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.language === undefined ? {} : { language: options.language }),
    },
    ...(options.size === undefined ? {} : { size: options.size }),
    ...(options.screens === undefined ? {} : { screens: options.screens }),
  })
}

function lines(frame: string): string[] {
  return frame.split('\n')
}

afterEach(() => cleanup())

describe('the tabs', () => {
  it.each([
    ['en', 'Home  Repositories  Rules  Reviews  Queue  Automation  Provider  Learnings'],
    ['pt', 'Início  Repositórios  Regras  Reviews  Fila  Automações  Provider  Aprendizados'],
    [
      'es',
      'Inicio  Repositorios  Reglas  Revisiones  Cola  Automatización  Proveedor  Aprendizajes',
    ],
  ])('show the full names when they fit (%s)', async (language, tabs) => {
    const { frame, until } = openApp({ language, size: { columns: 160, rows: 30 } })
    await until(() => lines(frame())[0]?.trim() === tabs)
    expect(lines(frame())[0]?.trim()).toBe(tabs)
  })

  it.each([
    ['en', 'Home  Repositories  Rules  Reviews  Queue  Automation  Provider  Learnings'],
    ['pt', 'Início  Repos  Regras  Reviews  Fila  Auto  IA  Aprend.'],
    ['es', 'Inicio  Repos  Reglas  Revis.  Cola  Auto  IA  Aprend.'],
  ])('fit 80 columns (%s)', async (language, tabs) => {
    const { frame, until } = openApp({ language, size: { columns: 80, rows: 24 } })
    await until(() => lines(frame())[0]?.trim() === tabs)
    const rows = lines(frame())
    expect(rows[0]?.trim()).toBe(tabs)
    expect(rows.every((row) => [...row].length <= 80)).toBe(true)
    expect(rows).toHaveLength(24)
  })

  it.each([
    [
      'en',
      '[Home] Repositories  Rules  Reviews  Queue  Automation  Provider  Learnings',
      '3',
      'Home  Repositories [Rules] Reviews  Queue  Automation  Provider  Learnings',
    ],
    [
      'pt',
      '[Início] Repos  Regras  Reviews  Fila  Auto  IA  Aprend.',
      '8',
      'Início  Repos  Regras  Reviews  Fila  Auto  IA [Aprend.]',
    ],
    [
      'es',
      '[Inicio] Repos  Reglas  Revis.  Cola  Auto  IA  Aprend.',
      '4',
      'Inicio  Repos  Reglas [Revis.] Cola  Auto  IA  Aprend.',
    ],
  ])(
    'mark the active tab with brackets when the terminal has no colors or styles (%s)',
    async (language, first, key, moved) => {
      const { frame, press, until } = openApp({
        language,
        env: { TERM: 'dumb' },
        size: { columns: 80, rows: 24 },
      })
      await until(() => lines(frame())[0]?.trim() === first)
      expect(lines(frame())[0]?.trim()).toBe(first)
      await press(key)
      await until(() => lines(frame())[0]?.trim() === moved)
      const rows = lines(frame())
      expect(rows[0]?.trim()).toBe(moved)
      expect(rows.every((row) => [...row].length <= 80)).toBe(true)
    },
  )

  it('marks the active tab with brackets inside a window of tabs', async () => {
    const screens = Array.from({ length: 9 }, (_, index) => ({
      id: `s${index}`,
      title: () => ({ full: `Screen number ${index + 1}`, short: `Screen ${index + 1}` }),
      Screen: () => <Text>screen {index + 1}</Text>,
    }))
    const { frame, press, showing } = openApp({
      screens,
      env: { NO_COLOR: '1', TERM: 'dumb' },
      size: { columns: 80, rows: 24 },
    })
    await showing('screen 1')
    await press('9')
    await showing('screen 9')
    expect(lines(frame())[0]).toBe(
      '‹  Screen 3  Screen 4  Screen 5  Screen 6  Screen 7  Screen 8 [Screen 9]',
    )
  })

  it('show a window around the active tab with markers when even the short names do not fit', async () => {
    const screens = Array.from({ length: 9 }, (_, index) => ({
      id: `s${index}`,
      title: () => ({ full: `Screen number ${index + 1}`, short: `Screen ${index + 1}` }),
      Screen: () => <Text>screen {index + 1}</Text>,
    }))
    const { frame, press, showing } = openApp({ screens, size: { columns: 80, rows: 24 } })
    await showing('screen 1')
    expect(lines(frame())[0]).toBe(
      '   Screen 1  Screen 2  Screen 3  Screen 4  Screen 5  Screen 6  Screen 7  ›',
    )
    await press('9')
    await showing('screen 9')
    expect(lines(frame())[0]).toBe(
      '‹  Screen 3  Screen 4  Screen 5  Screen 6  Screen 7  Screen 8  Screen 9',
    )
    expect(frame()).toContain('screen 9')
  })
})

describe('navigation', () => {
  it('jumps with the numbers and cycles with the arrows and Tab', async () => {
    const screens = SCREENS.map((screen) => ({
      ...screen,
      Screen: () => <Text>showing {screen.id}</Text>,
    }))
    const { frame, press, showing } = openApp({ screens })
    await showing('showing home')
    expect(frame()).toContain('showing home')
    await press('3')
    await showing('showing rules')
    expect(frame()).toContain('showing rules')
    await press(KEYS.left, KEYS.left)
    await showing('showing home')
    expect(frame()).toContain('showing home')
    await press(KEYS.left)
    await showing('showing learnings')
    expect(frame()).toContain('showing learnings')
    await press(KEYS.right)
    await showing('showing home')
    expect(frame()).toContain('showing home')
    await press(KEYS.tab, KEYS.tab)
    await showing('showing rules')
    expect(frame()).toContain('showing rules')
    await press(KEYS.shiftTab)
    await showing('showing repositories')
    expect(frame()).toContain('showing repositories')
    await press('9', KEYS.right)
    await showing('showing rules')
    expect(frame()).toContain('showing rules')
  })

  it('draws the screens it is given instead of its own', async () => {
    const { frame, showing } = openApp({
      screens: [
        { id: 'rules', title: (m) => m.screens.rules, Screen: () => <Text>given screen</Text> },
      ],
    })
    await showing('given screen')
    expect(frame()).toContain('given screen')
    expect(frame()).not.toContain('Phada v1.2.3')
  })

  it('shows the Home with the version and the folder under ~', async () => {
    const { frame, showing } = openApp()
    await showing('Phada v1.2.3', '~/code/shop')
    expect(frame()).toContain('Phada v1.2.3')
    expect(frame()).toContain('~/code/shop')
    expect(frame()).toContain('▐███▙ ┃ ▟███▌')
  })
})

describe('the footer', () => {
  it('lists the keys of the screen and the global ones', async () => {
    const { frame, showing } = openApp({ screens: [keyedScreen()] })
    await showing('Space mark')
    expect(lines(frame()).at(-1)?.trim()).toBe(
      '↑/↓ select · Enter open · r refresh · Space mark · ←/→ screens · / go to · ? help · q quit',
    )
  })

  it('ends with "? more" when the keys do not fit', async () => {
    const { frame, showing } = openApp({
      screens: [keyedScreen()],
      size: { columns: 80, rows: 24 },
    })
    await showing('Space mark')
    expect(lines(frame()).at(-1)).toBe(
      '↑/↓ select · Enter open · r refresh · Space mark · ←/→ screens · ? more',
    )
  })

  it('is translated', async () => {
    const { footer, until } = openApp({ language: 'pt-BR' })
    const translated = 'r atualizar · ←/→ telas · / ir para · ? ajuda · q sair'
    await until(() => footer().trim() === translated)
    expect(footer().trim()).toBe(translated)
  })
})

describe('the language', () => {
  it('follows the user config while the app is open, keeping the last good one on an error', async () => {
    let read: () => Promise<string | undefined> = async () => 'pt-BR'
    const footer = (frame: string) => lines(frame).at(-1)?.trim()
    const { frame, clock, until } = renderApp({
      deps: { readLanguage: () => read() },
      screens: [keyedScreen()],
    })
    await until(() => footer(frame())?.includes('telas') === true)
    expect(footer(frame())).toContain('telas')

    read = async () => 'es'
    clock.advance(2000)
    await until(() => footer(frame())?.includes('pantallas') === true)
    expect(footer(frame())).toContain('pantallas')

    let refused = false
    read = () => {
      refused = true
      return Promise.reject(new Error('Invalid config'))
    }
    clock.advance(2000)
    await until(() => refused)
    expect(footer(frame())).toContain('pantallas')

    read = async () => undefined
    clock.advance(2000)
    await until(() => footer(frame())?.includes('screens') === true)
    expect(footer(frame())).toContain('screens')
  })
})

describe('help', () => {
  it('lists every key, the screen ones first, and closes with Esc or ?', async () => {
    const { frame, press, showing, exits } = openApp({ screens: [keyedScreen()] })
    await showing('keyed screen', 'Space mark')
    await press('?')
    await showing('Keys', /Space\s+mark/)
    expect(frame()).toContain('Keys')
    expect(frame()).toMatch(/Space\s+mark/)
    expect(frame()).toMatch(/1–1\s+go to a screen by its number/)
    expect(frame()).toMatch(/Esc\s+back/)
    expect(frame()).not.toContain('keyed screen')
    await press(KEYS.escape)
    await showing('keyed screen')
    expect(frame()).not.toContain('Keys')
    expect(frame()).toContain('keyed screen')
    await press('?')
    await showing('Keys')
    await press('?')
    await showing('keyed screen')
    expect(frame()).not.toContain('Keys')
    expect(exits).toEqual([])
  })
})

describe('the palette', () => {
  it('filters the screens as you type and jumps with Enter', async () => {
    const { frame, press, showing } = openApp()
    await showing('Phada v1.2.3')
    await press('/', 'r', 'e')
    await showing('/ re')
    const palette = lines(frame()).slice(1).join('\n')
    expect(palette).toContain('❯ Repositories')
    expect(palette).toContain('Reviews')
    expect(palette).not.toContain('Queue')
    await press(KEYS.down, KEYS.enter)
    await showing('No reviews yet.')
    expect(frame()).not.toContain('❯')
    expect(frame()).toContain('No reviews yet.')
  })

  it('matches the English names and ignores accents in another language', async () => {
    const { frame, press, showing } = openApp({ language: 'pt' })
    await showing('Início  Repos')
    await press('/', 'q', 'u', 'e')
    await showing('/ que', '❯ Fila')
    expect(frame()).toContain('❯ Fila')
    await press(KEYS.backspace, KEYS.backspace, KEYS.backspace, 'i', 'n', 'i', 'c')
    await showing('/ inic', '❯ Início')
    expect(frame()).toContain('❯ Início')
  })

  it('types the global keys into the query and closes with Esc', async () => {
    const { frame, press, showing, exits } = openApp()
    await showing('Phada v1.2.3')
    await press('/', 'q', '1')
    await showing('No screen matches.')
    expect(frame()).toContain('No screen matches.')
    await press(KEYS.escape)
    await showing('Phada v1.2.3')
    expect(frame()).toContain('Phada v1.2.3')
    expect(exits).toEqual([])
  })
})

describe('Esc and q', () => {
  it('closes the open detail of a screen before quitting', async () => {
    const { frame, press, showing, exits } = openApp({ screens: [detailScreen()] })
    await showing('list')
    await press(KEYS.enter)
    await showing('detail open')
    expect(frame()).toContain('detail open')
    await press(KEYS.escape)
    await showing('list')
    expect(frame()).toContain('list')
    expect(exits).toEqual([])
    await press(KEYS.escape)
    await waitFor(() => exits.length > 0)
    expect(exits).toEqual([{ kind: 'quit' }])
  })

  it('quits with q', async () => {
    const { press, showing, exits } = openApp()
    await showing('Phada v1.2.3')
    await press('q')
    await waitFor(() => exits.length > 0)
    expect(exits).toEqual([{ kind: 'quit' }])
  })

  it('stops on Ctrl-C, even with the palette open', async () => {
    const { press, showing, exits } = openApp()
    await showing('Phada v1.2.3')
    await press('/')
    await showing('Go to')
    await press(KEYS.ctrlC)
    await waitFor(() => exits.length > 0)
    expect(exits).toEqual([{ kind: 'interrupted' }])
  })
})

describe('the size of the terminal', () => {
  it('warns below 80×24 with the current size and redraws on resize', async () => {
    const { frame, resize, press, showing, exits } = openApp({ size: { columns: 70, rows: 20 } })
    await showing('The terminal is 70×20')
    expect(frame()).toContain('The terminal is 70×20. Phada needs at least 80×24')
    expect(frame()).not.toContain('Home')
    resize({ columns: 120, rows: 30 })
    await showing('Phada v1.2.3')
    expect(frame()).toContain('Phada v1.2.3')
    expect(lines(frame())).toHaveLength(30)
    resize({ columns: 80, rows: 23 })
    await showing('80×23')
    expect(frame()).toContain('80×23')
    await press('q')
    await waitFor(() => exits.length > 0)
    expect(exits).toEqual([{ kind: 'quit' }])
  })

  it('warns in the language of the config', async () => {
    const { frame, showing } = openApp({ language: 'es', size: { columns: 60, rows: 30 } })
    await showing('La terminal mide 60×30')
    expect(frame()).toContain('La terminal mide 60×30')
  })
})

describe('the mascot', () => {
  it('flaps its wings only while a screen is working', async () => {
    let finish = () => {}
    const screen: ScreenDefinition = {
      id: 'home',
      title: (messages) => messages.screens.home,
      Screen: () => {
        const [busy, setBusy] = useState(true)
        finish = () => setBusy(false)
        useWorking(busy)
        return <Mascot />
      },
    }
    const open = MASCOT_FRAMES[0]?.[1]?.trim() ?? ''
    const closed = MASCOT_FRAMES[1]?.[1]?.trim() ?? ''
    const { frame, clock } = openApp({ screens: [screen] })
    await waitFor(() => clock.active(FLAP_MS) === 1 && frame().includes(open))
    clock.advance(FLAP_MS)
    await waitFor(() => frame().includes(closed))
    expect(frame()).toContain(closed)
    clock.advance(FLAP_MS)
    await waitFor(() => frame().includes(open))
    expect(frame()).toContain(open)
    clock.advance(FLAP_MS)
    await waitFor(() => frame().includes(closed))
    finish()
    await waitFor(() => clock.active(FLAP_MS) === 0 && frame().includes(open))
    expect(clock.active(FLAP_MS)).toBe(0)
    expect(frame()).toContain(open)
  })
})

describe('colors', () => {
  const level = inkChalk.level
  beforeAll(() => {
    inkChalk.level = 3
  })
  afterAll(() => {
    inkChalk.level = level
  })

  it('paints the Violeta accent in truecolor', async () => {
    const { frame, showing } = openApp({ env: { COLORTERM: 'truecolor' } })
    await showing('\u001B[38;2;139;92;246m')
    expect(frame()).toContain('\u001B[38;2;139;92;246m')
  })

  it('paints no color with NO_COLOR, keeping bold and inverse', async () => {
    const { frame, showing } = openApp({ env: { NO_COLOR: '1', COLORTERM: 'truecolor' } })
    await showing('Phada', '\u001B[7m')
    expect(frame()).not.toMatch(/\u001B\[(?:3[0-9]|4[0-9]|9[0-7]|10[0-7])[;m]/)
    expect(frame()).toContain('\u001B[7m')
    expect(frame()).toContain('Phada')
  })
})

function keyedScreen(): ScreenDefinition {
  return {
    id: 'keyed',
    title: () => ({ full: 'Keyed', short: 'Keyed' }),
    Screen: () => {
      useScreenKeys([
        { keys: '↑/↓', label: 'select' },
        { keys: 'Enter', label: 'open' },
        { keys: 'r', label: 'refresh' },
        { keys: 'Space', label: 'mark' },
      ])
      return <Text>keyed screen</Text>
    },
  }
}

function detailScreen(): ScreenDefinition {
  return {
    id: 'detail',
    title: () => ({ full: 'Detail', short: 'Detail' }),
    Screen: () => {
      const [open, setOpen] = useState(false)
      useBack(open ? () => setOpen(false) : undefined)
      useScreenInput((_input, key) => {
        if (key.return) setOpen(true)
      })
      return <Text>{open ? 'detail open' : 'list'}</Text>
    },
  }
}
