import chalk from 'chalk'
import { Text } from 'ink'
import { cleanup, render } from 'ink-testing-library'
import { useState } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { App } from './app.js'
import type { AppResult } from './app.js'
import { useBack, useScreenInput, useScreenKeys, useWorking } from './app-context.js'
import type { AppDeps, Scheduler } from './app-context.js'
import { SCREENS } from './screens.js'
import type { ScreenDefinition } from './screens.js'
import { HomeScreen } from './screens/home.js'
import type { SizeSource, TerminalSize } from './terminal-size.js'

const ESC = '\u001B'
const KEYS = {
  right: `${ESC}[C`,
  left: `${ESC}[D`,
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  tab: '\t',
  shiftTab: `${ESC}[Z`,
  enter: '\r',
  escape: ESC,
  backspace: '\u007F',
  ctrlC: '\u0003',
}

function fakeSize(initial: TerminalSize) {
  let size = initial
  const listeners = new Set<() => void>()
  const source: SizeSource = {
    current: () => size,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    source,
    resize: (next: TerminalSize) => {
      size = next
      for (const listener of listeners) listener()
    },
  }
}

function fakeScheduler() {
  const ticks = new Map<number, { ms: number; tick: () => void }>()
  let next = 0
  const scheduler: Scheduler = {
    every: (ms, tick) => {
      const id = next++
      ticks.set(id, { ms, tick })
      return () => ticks.delete(id)
    },
  }
  return {
    scheduler,
    advance: (ms: number) => {
      for (const { ms: every, tick } of [...ticks.values()]) if (every <= ms) tick()
    },
    active: () => ticks.size,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

function openApp(
  options: {
    language?: string
    env?: AppDeps['env']
    size?: TerminalSize
    screens?: readonly ScreenDefinition[]
  } = {},
) {
  const size = fakeSize(options.size ?? { columns: 100, rows: 30 })
  const clock = fakeScheduler()
  const exits: AppResult[] = []
  const deps: AppDeps = {
    version: '1.2.3',
    cwd: '/home/ana/code/shop',
    home: '/home/ana',
    env: options.env ?? { TERM: 'xterm-256color' },
    scheduler: clock.scheduler,
    ...(options.language === undefined ? {} : { language: options.language }),
  }
  const app = render(
    <App
      deps={deps}
      size={size.source}
      onExit={(result) => exits.push(result)}
      {...(options.screens === undefined ? {} : { screens: options.screens })}
    />,
  )
  const frame = () => app.lastFrame() ?? ''
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      app.stdin.write(key)
      await settle()
    }
  }
  return { app, frame, press, exits, resize: size.resize, clock }
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
    const { frame } = openApp({ language, size: { columns: 160, rows: 30 } })
    await settle()
    expect(lines(frame())[0]?.trim()).toBe(tabs)
  })

  it.each([
    ['en', 'Home  Repositories  Rules  Reviews  Queue  Automation  Provider  Learnings'],
    ['pt', 'Início  Repos  Regras  Reviews  Fila  Auto  IA  Aprend.'],
    ['es', 'Inicio  Repos  Reglas  Revis.  Cola  Auto  IA  Aprend.'],
  ])('fit 80 columns (%s)', async (language, tabs) => {
    const { frame } = openApp({ language, size: { columns: 80, rows: 24 } })
    await settle()
    const rows = lines(frame())
    expect(rows[0]?.trim()).toBe(tabs)
    expect(rows.every((row) => [...row].length <= 80)).toBe(true)
    expect(rows).toHaveLength(24)
  })

  it('show a window around the active tab with markers when even the short names do not fit', async () => {
    const screens = Array.from({ length: 9 }, (_, index) => ({
      id: `s${index}`,
      title: () => ({ full: `Screen number ${index + 1}`, short: `Screen ${index + 1}` }),
      Screen: () => <Text>screen {index + 1}</Text>,
    }))
    const { frame, press } = openApp({ screens, size: { columns: 80, rows: 24 } })
    await settle()
    expect(lines(frame())[0]).toBe(
      '   Screen 1  Screen 2  Screen 3  Screen 4  Screen 5  Screen 6  Screen 7  ›',
    )
    await press('9')
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
    const { frame, press } = openApp({ screens })
    await settle()
    expect(frame()).toContain('showing home')
    await press('3')
    expect(frame()).toContain('showing rules')
    await press(KEYS.left, KEYS.left)
    expect(frame()).toContain('showing home')
    await press(KEYS.left)
    expect(frame()).toContain('showing learnings')
    await press(KEYS.right)
    expect(frame()).toContain('showing home')
    await press(KEYS.tab, KEYS.tab)
    expect(frame()).toContain('showing rules')
    await press(KEYS.shiftTab)
    expect(frame()).toContain('showing repositories')
    await press('9')
    expect(frame()).toContain('showing repositories')
  })

  it('shows an honest placeholder on the screens not drawn yet', async () => {
    const { frame, press } = openApp()
    await settle()
    await press('5')
    expect(frame()).toContain('This screen is not ready yet.')
    expect(frame()).not.toContain('Phada v1.2.3')
  })

  it('shows the Home with the version and the folder under ~', async () => {
    const { frame } = openApp()
    await settle()
    expect(frame()).toContain('Phada v1.2.3')
    expect(frame()).toContain('~/code/shop')
    expect(frame()).toContain('▐███▙ ● ▟███▌')
  })
})

describe('the footer', () => {
  it('lists the keys of the screen and the global ones', async () => {
    const { frame } = openApp({ screens: [keyedScreen()] })
    await settle()
    expect(lines(frame()).at(-1)?.trim()).toBe(
      '↑/↓ select · Enter open · r refresh · Space mark · ←/→ screens · / go to · ? help · q quit',
    )
  })

  it('ends with "? more" when the keys do not fit', async () => {
    const { frame } = openApp({ screens: [keyedScreen()], size: { columns: 80, rows: 24 } })
    await settle()
    expect(lines(frame()).at(-1)).toBe(
      '↑/↓ select · Enter open · r refresh · Space mark · ←/→ screens · ? more',
    )
  })

  it('is translated', async () => {
    const { frame } = openApp({ language: 'pt-BR' })
    await settle()
    expect(lines(frame()).at(-1)?.trim()).toBe('←/→ telas · / ir para · ? ajuda · q sair')
  })
})

describe('help', () => {
  it('lists every key, the screen ones first, and closes with Esc or ?', async () => {
    const { frame, press, exits } = openApp({ screens: [keyedScreen()] })
    await settle()
    await press('?')
    expect(frame()).toContain('Keys')
    expect(frame()).toMatch(/Space\s+mark/)
    expect(frame()).toMatch(/1–1\s+go to a screen by its number/)
    expect(frame()).toMatch(/Esc\s+back/)
    expect(frame()).not.toContain('keyed screen')
    await press(KEYS.escape)
    expect(frame()).not.toContain('Keys')
    expect(frame()).toContain('keyed screen')
    await press('?', '?')
    expect(frame()).not.toContain('Keys')
    expect(exits).toEqual([])
  })
})

describe('the palette', () => {
  it('filters the screens as you type and jumps with Enter', async () => {
    const { frame, press } = openApp()
    await settle()
    await press('/', 'r', 'e')
    const palette = lines(frame()).slice(1).join('\n')
    expect(palette).toContain('❯ Repositories')
    expect(palette).toContain('Reviews')
    expect(palette).not.toContain('Queue')
    await press(KEYS.down, KEYS.enter)
    expect(frame()).not.toContain('❯')
    expect(frame()).toContain('This screen is not ready yet.')
  })

  it('matches the English names and ignores accents in another language', async () => {
    const { frame, press } = openApp({ language: 'pt' })
    await settle()
    await press('/', 'q', 'u', 'e')
    expect(frame()).toContain('❯ Fila')
    await press(KEYS.backspace, KEYS.backspace, KEYS.backspace, 'i', 'n', 'i', 'c')
    expect(frame()).toContain('❯ Início')
  })

  it('types the global keys into the query and closes with Esc', async () => {
    const { frame, press, exits } = openApp()
    await settle()
    await press('/', 'q', '1')
    expect(frame()).toContain('No screen matches.')
    await press(KEYS.escape)
    expect(frame()).toContain('Phada v1.2.3')
    expect(exits).toEqual([])
  })
})

describe('Esc and q', () => {
  it('closes the open detail of a screen before quitting', async () => {
    const { frame, press, exits } = openApp({ screens: [detailScreen()] })
    await settle()
    await press(KEYS.enter)
    expect(frame()).toContain('detail open')
    await press(KEYS.escape)
    expect(frame()).toContain('list')
    expect(exits).toEqual([])
    await press(KEYS.escape)
    expect(exits).toEqual([{ kind: 'quit' }])
  })

  it('quits with q', async () => {
    const { press, exits } = openApp()
    await settle()
    await press('q')
    expect(exits).toEqual([{ kind: 'quit' }])
  })

  it('stops on Ctrl-C, even with the palette open', async () => {
    const { press, exits } = openApp()
    await settle()
    await press('/', KEYS.ctrlC)
    expect(exits).toEqual([{ kind: 'interrupted' }])
  })
})

describe('the size of the terminal', () => {
  it('warns below 80×24 with the current size and redraws on resize', async () => {
    const { frame, resize, press, exits } = openApp({ size: { columns: 70, rows: 20 } })
    await settle()
    expect(frame()).toContain('The terminal is 70×20. Phada needs at least 80×24')
    expect(frame()).not.toContain('Home')
    resize({ columns: 120, rows: 30 })
    await settle()
    expect(frame()).toContain('Phada v1.2.3')
    expect(lines(frame())).toHaveLength(30)
    resize({ columns: 80, rows: 23 })
    await settle()
    expect(frame()).toContain('80×23')
    await press('q')
    expect(exits).toEqual([{ kind: 'quit' }])
  })

  it('warns in the language of the config', async () => {
    const { frame } = openApp({ language: 'es', size: { columns: 60, rows: 30 } })
    await settle()
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
        return <HomeScreen />
      },
    }
    const { frame, clock } = openApp({ screens: [screen] })
    await settle()
    expect(frame()).toContain('▐███▙ ● ▟███▌')
    clock.advance(450)
    await settle()
    expect(frame()).toContain('▐█●█▌')
    clock.advance(450)
    await settle()
    expect(frame()).toContain('▐███▙ ● ▟███▌')
    finish()
    await settle()
    expect(clock.active()).toBe(0)
    expect(frame()).toContain('▐███▙ ● ▟███▌')
  })
})

describe('colors', () => {
  const level = chalk.level
  beforeAll(() => {
    chalk.level = 3
  })
  afterAll(() => {
    chalk.level = level
  })

  it('paints the Violeta accent in truecolor', async () => {
    const { frame } = openApp({ env: { COLORTERM: 'truecolor' } })
    await settle()
    expect(frame()).toContain('\u001B[38;2;139;92;246m')
  })

  it('paints no color with NO_COLOR, keeping bold and inverse', async () => {
    const { frame } = openApp({ env: { NO_COLOR: '1', COLORTERM: 'truecolor' } })
    await settle()
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
