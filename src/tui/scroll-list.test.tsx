import { Text } from 'ink'
import { cleanup } from 'ink-testing-library'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { frameLines, KEYS, renderApp, settle } from '../../test/support/tui.js'
import { useBack, useScreenSize } from './app-context.js'
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
    const { frame, press } = renderApp({
      screens: [listScreen(NAMES, {}, opened)],
      size: { columns: 80, rows: 24 },
    })
    await settle()
    const rows = frameLines(frame())
    expect(rows).toHaveLength(24)
    expect(frame()).toContain('❯ item 1')
    expect(frame()).toContain('item 19')
    expect(frame()).not.toContain('item 20')
    expect(frame()).toContain('1–19 of 40')
    await press(...Array<string>(19).fill(KEYS.down))
    expect(frame()).toContain('❯ item 20')
    expect(frame()).toContain('2–20 of 40')
    expect(frame()).not.toMatch(/item 1\b/)
    await press(KEYS.pageDown, KEYS.pageDown)
    expect(frame()).toContain('❯ item 40')
    expect(frame()).toContain('22–40 of 40')
    await press(KEYS.down, KEYS.enter)
    expect(opened).toEqual(['item 40'])
    await press(KEYS.pageUp)
    expect(frame()).toContain('❯ item 30')
  })

  it('keeps the selected item when the list changes under it, or the same place when it is gone', async () => {
    const setItems: { current?: (items: string[]) => void } = {}
    const { frame, press } = renderApp({ screens: [listScreen(['a', 'b', 'c'], setItems, [])] })
    await settle()
    await press(KEYS.down)
    expect(frame()).toContain('❯ b')
    setItems.current?.(['new', 'a', 'b', 'c'])
    await settle()
    expect(frame()).toContain('❯ b')
    setItems.current?.(['new', 'a', 'c'])
    await settle()
    expect(frame()).toContain('❯ c')
    setItems.current?.(['new'])
    await settle()
    expect(frame()).toContain('❯ new')
  })

  it('is translated', async () => {
    const { frame } = renderApp({
      deps: { language: 'pt' },
      screens: [listScreen(NAMES, {}, [])],
      size: { columns: 80, rows: 24 },
    })
    await settle()
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
    const { frame, press } = renderApp({ screens: [screen] })
    await settle()
    await press(KEYS.down, KEYS.enter)
    expect(frame()).toContain('two item 9')
    expect(frame()).not.toContain('two item 10')
    expect(frame()).toContain('1–9 of 40')
    await press(KEYS.down, KEYS.down)
    expect(frame()).toContain('3–11 of 40')
    expect(frame()).not.toContain('two item 2\n')
    await press(KEYS.pageDown, KEYS.pageDown, KEYS.pageDown, KEYS.pageDown, KEYS.pageDown)
    expect(frame()).toContain('32–40 of 40')
    await press(KEYS.escape, KEYS.enter)
    expect(opened).toEqual(['two', 'two'])
    expect(frame()).toContain('1–9 of 40')
  })
})
