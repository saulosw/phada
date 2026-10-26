import { Text } from 'ink'
import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { KEYS, renderApp, waitFor } from '../../test/support/tui.js'
import { useScreenInput, useScreenKeys, useScreenSize } from './app-context.js'
import type { ScreenDefinition } from './screens.js'
import { TextFieldLine, useTextField } from './text-field.js'

afterEach(() => cleanup())

function fieldScreen(submitted: string[] = [], emptyOnFocus = false): ScreenDefinition {
  return {
    id: 'field',
    title: () => ({ full: 'Field', short: 'Field' }),
    Screen: () => {
      const field = useTextField({ emptyOnFocus, onSubmit: (value) => submitted.push(value) })
      useScreenKeys(
        field.focused ? [{ keys: 'Enter', label: 'apply' }] : [{ keys: 'f', label: 'filter' }],
      )
      useScreenInput((input) => {
        if (input === 'f') field.focus()
      })
      return (
        <>
          <TextFieldLine label="Filter" field={field} />
          <Text>applied: [{field.value}]</Text>
        </>
      )
    },
  }
}

describe('a text field', () => {
  it('takes every key while focused, so the shell keys type into it', async () => {
    const submitted: string[] = []
    const { frame, press, type, showing, exits } = renderApp({ screens: [fieldScreen(submitted)] })
    await showing('f filter')
    await press('f')
    await showing('Enter apply')
    await type('q/?1 x')
    await showing('Filter: q/?1 x')
    expect(frame()).toContain('Filter: q/?1 x')
    expect(frame()).toContain('applied: []')
    expect(frame()).not.toContain('Keys')
    expect(exits).toEqual([])
    await press(KEYS.backspace, KEYS.backspace, KEYS.enter)
    await showing('applied: [q/?1]')
    expect(frame()).toContain('applied: [q/?1]')
    expect(submitted).toEqual(['q/?1'])
  })

  it('leaves with Esc without applying, and Esc then goes back to the shell', async () => {
    const { frame, press, type, showing, exits } = renderApp({ screens: [fieldScreen()] })
    await showing('f filter')
    await press('f')
    await showing('Enter apply')
    await type('shop')
    await press(KEYS.enter)
    await showing('applied: [shop]', 'f filter')
    await press('f')
    await showing('Enter apply')
    await type('-api')
    await showing('Filter: shop-api')
    await press(KEYS.escape)
    await showing('f filter')
    expect(frame()).toContain('applied: [shop]')
    expect(frame()).toContain('Filter: shop')
    expect(exits).toEqual([])
    await press(KEYS.escape)
    await waitFor(() => exits.length > 0)
    expect(exits).toEqual([{ kind: 'quit' }])
  })

  it('shows only the keys of the field in the footer while typing, and still stops on Ctrl-C', async () => {
    const { footer, press, showing, exits } = renderApp({ screens: [fieldScreen()] })
    await showing('f filter')
    expect(footer()).toContain('q quit')
    await press('f')
    await waitFor(() => footer().trim() === 'Enter apply')
    expect(footer().trim()).toBe('Enter apply')
    await press(KEYS.ctrlC)
    await waitFor(() => exits.length > 0)
    expect(exits).toEqual([{ kind: 'interrupted' }])
  })

  it('takes a write of several keys with Enter in it, typing the text before applying it', async () => {
    const submitted: string[] = []
    const { frame, press, showing } = renderApp({ screens: [fieldScreen(submitted)] })
    await showing('f filter')
    await press('f', '15\r')
    await showing('applied: [15]', 'f filter')
    expect(frame()).toContain('applied: [15]')
    expect(submitted).toEqual(['15'])
    await press('f')
    await showing('Enter apply')
    await press(`1\u007F2\t3${KEYS.escape}`)
    await showing('f filter')
    expect(frame()).toContain('applied: [15]')
    expect(frame()).toContain('Filter: 15')
    expect(submitted).toEqual(['15'])
  })

  it('opens empty when asked to, so typing replaces the applied value', async () => {
    const submitted: string[] = []
    const { frame, press, type, showing } = renderApp({ screens: [fieldScreen(submitted, true)] })
    await showing('f filter')
    await press('f', '15\r')
    await showing('applied: [15]', 'f filter')
    await press('f')
    await showing('Enter apply')
    expect(frame()).toMatch(/Filter: *$/m)
    await type('16')
    await press(KEYS.enter)
    await showing('applied: [16]', 'f filter')
    expect(frame()).toContain('applied: [16]')
    expect(submitted).toEqual(['15', '16'])
    await press('f')
    await showing('Enter apply')
    await press(KEYS.escape)
    await showing('f filter')
    expect(frame()).toContain('Filter: 16')
  })

  it('does not pass the typed keys to the other inputs of the screen', async () => {
    const seen: string[] = []
    const screen: ScreenDefinition = {
      id: 'both',
      title: () => ({ full: 'Both', short: 'Both' }),
      Screen: () => {
        const field = useTextField()
        useScreenKeys(
          field.focused ? [{ keys: 'Enter', label: 'apply' }] : [{ keys: 'f', label: 'find' }],
        )
        useScreenInput((input) => {
          if (input === 'f') field.focus()
          else seen.push(input)
        })
        return <TextFieldLine label="Find" field={field} />
      },
    }
    const { press, type, showing } = renderApp({ screens: [screen] })
    await showing('f find')
    await press('f')
    await showing('Enter apply')
    await type('rx')
    await press(KEYS.enter)
    await showing('f find')
    await press('r')
    await waitFor(() => seen.length > 0)
    expect(seen).toEqual(['r'])
  })
})

describe('the size of a screen', () => {
  it('is the terminal without the tabs and the footer', async () => {
    const screen: ScreenDefinition = {
      id: 'size',
      title: () => ({ full: 'Size', short: 'Size' }),
      Screen: () => {
        const { columns, rows } = useScreenSize()
        return <Text>{`${columns}x${rows}`}</Text>
      },
    }
    const { frame, showing, resize } = renderApp({
      screens: [screen],
      size: { columns: 80, rows: 24 },
    })
    await showing('80x21')
    expect(frame()).toContain('80x21')
    resize({ columns: 160, rows: 40 })
    await showing('160x37')
    expect(frame()).toContain('160x37')
  })
})
