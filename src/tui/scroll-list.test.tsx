import { Text } from 'ink'
import { cleanup } from 'ink-testing-library'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { frameLines, KEYS, renderApp, waitFor } from '../../test/support/tui.js'
import { useBack, useScreenKeys, useScreenSize } from './app-context.js'
import type { ScreenDefinition } from './screens.js'
import { listWindow, ScrollList, ScrollText, useSelection } from './scroll-list.js'

afterEach(() => cleanup())

describe('listWindow', () => {
  it('shows everything when it fits', () => {
    expect(listWindow(5, 4, 10, 0)).toEqual({ start: 0, end: 5, overflow: false })
  })

  it('keeps one row for the hint and moves only when the selection leaves the window', () => {
    expect(listWindow(30, 0, 10, 0)).toEqual({ start: 0, end: 9, overflow: true })
    expect(listWindow(30, 8, 10, 0)).toEqual({ start: 0, end: 9, overflow: true })
    expect(listWindow(30, 9, 10, 0)).toEqual({ start: 1, end: 10, overflow: true })
    expect(listWindow(30, 5, 10, 3)).toEqual({ start: 3, end: 12, overflow: true })
    expect(listWindow(30, 2, 10, 3)).toEqual({ start: 2, end: 11, overflow: true })
    expect(listWindow(30, 29, 10, 0)).toEqual({ start: 21, end: 30, overflow: true })
  })

  it('pulls the window back when the list shrinks', () => {
    expect(listWindow(12, 11, 10, 20)).toEqual({ start: 3, end: 12, overflow: true })
  })
})

function listScreen(
  initial: string[],
  setItems: { current?: (items: string[]) => void },
  opened: string[],
): ScreenDefinition {
  return {
    id: 'list',
    title: () => ({ full: 'List', short: 'List' }),
    Screen: () => {
      const [items, update] = useState(initial)
      setItems.current = update
      const { rows } = useScreenSize()
      const selection = useSelection(items, (item) => item, {
        onOpen: (item) => opened.push(item),
      })
      return (
        <ScrollList
          items={items}
          index={selection.index}
          rows={rows - 1}
          keyOf={(item) => item}
          renderItem={(item) => <Text>{item}</Text>}
        />
      )
    },
  }
}

const NAMES = Array.from({ length: 40 }, (_, index) => `item ${index + 1}`)

describe('ScrollList', () => {
  it('fits the height with an "n–m of N" hint and scrolls with the arrows and the page keys', async () => {
    const opened: string[] = []
    const { frame, press, showing } = renderApp({
      screens: [listScreen(NAMES, {}, opened)],
      size: { columns: 80, rows: 24 },
    })
    await showing('1–19 of 40')
    const rows = frameLines(frame())
    expect(rows).toHaveLength(24)
    expect(frame()).toContain('❯ item 1')
    expect(frame()).toContain('item 19')
    expect(frame()).not.toContain('item 20')
    expect(frame()).toContain('1–19 of 40')
    await press(...Array<string>(19).fill(KEYS.down))
    await showing('❯ item 20', '2–20 of 40')
    expect(frame()).toContain('❯ item 20')
    expect(frame()).toContain('2–20 of 40')
    expect(frame()).not.toMatch(/item 1\b/)
    await press(KEYS.pageDown, KEYS.pageDown)
    await showing('❯ item 40', '22–40 of 40')
    expect(frame()).toContain('❯ item 40')
    expect(frame()).toContain('22–40 of 40')
    await press(KEYS.down, KEYS.enter)
    await waitFor(() => opened.length > 0)
    expect(opened).toEqual(['item 40'])
    await press(KEYS.pageUp)
    await showing('❯ item 30')
    expect(frame()).toContain('❯ item 30')
  })

  it('opens the item the keys moved to when they arrive in one write', async () => {
    const opened: string[] = []
    const { frame, press, showing } = renderApp({ screens: [listScreen(NAMES, {}, opened)] })
    await showing('❯ item 1')
    await press(
      `${KEYS.down}${KEYS.enter}`,
      `${KEYS.end}${KEYS.enter}`,
      `${KEYS.up}${KEYS.up}${KEYS.enter}`,
    )
    await waitFor(() => opened.length >= 3)
    await showing('❯ item 38')
    expect(opened).toEqual(['item 2', 'item 40', 'item 38'])
    expect(frame()).toContain('❯ item 38')
  })

  it('keeps the selected item when the list changes under it, or the same place when it is gone', async () => {
    const setItems: { current?: (items: string[]) => void } = {}
    const { frame, press, showing } = renderApp({
      screens: [listScreen(['a', 'b', 'c'], setItems, [])],
    })
    await showing('❯ a')
    await press(KEYS.down)
    await showing('❯ b')
    expect(frame()).toContain('❯ b')
    setItems.current?.(['new', 'a', 'b', 'c'])
    await showing('new', '❯ b')
    expect(frame()).toContain('❯ b')
    setItems.current?.(['new', 'a', 'c'])
    await showing('❯ c')
    expect(frame()).toContain('❯ c')
    setItems.current?.(['new'])
    await showing('❯ new')
    expect(frame()).toContain('❯ new')
  })

  it('is translated', async () => {
    const { frame, showing } = renderApp({
      deps: { language: 'pt' },
      screens: [listScreen(NAMES, {}, [])],
      size: { columns: 80, rows: 24 },
    })
    await showing('1–19 de 40')
    expect(frame()).toContain('1–19 de 40')
  })
})

describe('ScrollText', () => {
  it('scrolls lines that do not fit, and the selection keys of a list behind it stay still', async () => {
    const opened: string[] = []
    const screen: ScreenDefinition = {
      id: 'detail',
      title: () => ({ full: 'Detail', short: 'Detail' }),
      Screen: () => {
        const [open, setOpen] = useState<string | undefined>()
        const items = ['one', 'two']
        const selection = useSelection(items, (item) => item, {
          active: open === undefined,
          onOpen: (item) => {
            opened.push(item)
            setOpen(item)
          },
        })
        useBack(open === undefined ? undefined : () => setOpen(undefined))
        useScreenKeys([
          open === undefined ? { keys: 'Enter', label: 'open' } : { keys: 'Esc', label: 'back' },
        ])
        if (open !== undefined) {
          return (
            <ScrollText
              rows={10}
              lines={NAMES.map((name) => (
                <Text key={name}>
                  {open} {name}
                </Text>
              ))}
            />
          )
        }
        return (
          <ScrollList
            items={items}
            index={selection.index}
            rows={10}
            keyOf={(item) => item}
            renderItem={(item) => <Text>{item}</Text>}
          />
        )
      },
    }
    const { frame, press, showing } = renderApp({ screens: [screen] })
    await showing('Enter open')
    await press(KEYS.down, KEYS.enter)
    await showing('Esc back', '1–9 of 40')
    expect(frame()).toContain('two item 9')
    expect(frame()).not.toContain('two item 10')
    expect(frame()).toContain('1–9 of 40')
    await press(KEYS.down, KEYS.down)
    await showing('3–11 of 40')
    expect(frame()).toContain('3–11 of 40')
    expect(frame()).not.toContain('two item 2\n')
    await press(KEYS.pageDown, KEYS.pageDown, KEYS.pageDown, KEYS.pageDown, KEYS.pageDown)
    await showing('32–40 of 40')
    expect(frame()).toContain('32–40 of 40')
    await press(KEYS.escape)
    await showing('Enter open')
    await press(KEYS.enter)
    await showing('Esc back', '1–9 of 40')
    expect(opened).toEqual(['two', 'two'])
    expect(frame()).toContain('1–9 of 40')
  })

  it('scrolls by every key of one write', async () => {
    const screen: ScreenDefinition = {
      id: 'text',
      title: () => ({ full: 'Text', short: 'Text' }),
      Screen: () => (
        <ScrollText
          rows={10}
          lines={NAMES.map((name) => (
            <Text key={name}>{name}</Text>
          ))}
        />
      ),
    }
    const { frame, press, showing } = renderApp({ screens: [screen] })
    await showing('1–9 of 40')
    await press(`${KEYS.down}${KEYS.down}${KEYS.down}`)
    await showing('4–12 of 40')
    expect(frame()).toContain('4–12 of 40')
  })
})
