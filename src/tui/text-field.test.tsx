import { Text } from 'ink'
import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import { frameLines, KEYS, renderApp, settle } from '../../test/support/tui.js'
import { useScreenInput, useScreenKeys, useScreenSize } from './app-context.js'
import type { ScreenDefinition } from './screens.js'
import { TextFieldLine, useTextField } from './text-field.js'

afterEach(() => cleanup())

function fieldScreen(submitted: string[] = []): ScreenDefinition {
  return {
    id: 'field',
    title: () => ({ full: 'Field', short: 'Field' }),
    Screen: () => {
      const field = useTextField({ onSubmit: (value) => submitted.push(value) })
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
    const { frame, press, type, exits } = renderApp({ screens: [fieldScreen(submitted)] })
    await settle()
    await press('f')
    await type('q/?1 x')
    expect(frame()).toContain('Filter: q/?1 x')
    expect(frame()).toContain('applied: []')
    expect(frame()).not.toContain('Keys')
    expect(exits).toEqual([])
    await press(KEYS.backspace, KEYS.backspace, KEYS.enter)
    expect(frame()).toContain('applied: [q/?1]')
    expect(submitted).toEqual(['q/?1'])
  })

  it('leaves with Esc without applying, and Esc then goes back to the shell', async () => {
    const { frame, press, type, exits } = renderApp({ screens: [fieldScreen()] })
    await settle()
    await press('f')
    await type('shop')
    await press(KEYS.enter, 'f')
    await type('-api')
    await press(KEYS.escape)
    expect(frame()).toContain('applied: [shop]')
    expect(frame()).toContain('Filter: shop')
    expect(exits).toEqual([])
    await press(KEYS.escape)
    expect(exits).toEqual([{ kind: 'quit' }])
  })

  it('shows only the keys of the field in the footer while typing, and still stops on Ctrl-C', async () => {
    const { frame, press, exits } = renderApp({ screens: [fieldScreen()] })
    await settle()
    expect(frameLines(frame()).at(-1)).toContain('q quit')
    await press('f')
    expect(frameLines(frame()).at(-1)?.trim()).toBe('Enter apply')
    await press(KEYS.ctrlC)
    expect(exits).toEqual([{ kind: 'interrupted' }])
  })

  it('takes a write of several keys with Enter in it, typing the text before applying it', async () => {
    const submitted: string[] = []
    const { frame, press } = renderApp({ screens: [fieldScreen(submitted)] })
    await settle()
    await press('f', '15\r')
    expect(frame()).toContain('applied: [15]')
    expect(submitted).toEqual(['15'])
    await press('f', `1\u007F2\t3${KEYS.escape}`)
    expect(frame()).toContain('applied: [15]')
    expect(frame()).toContain('Filter: 15')
    expect(submitted).toEqual(['15'])
  })

  it('does not pass the typed keys to the other inputs of the screen', async () => {
    const seen: string[] = []
    const screen: ScreenDefinition = {
      id: 'both',
      title: () => ({ full: 'Both', short: 'Both' }),
      Screen: () => {
        const field = useTextField()
        useScreenInput((input) => {
          if (input === 'f') field.focus()
          else seen.push(input)
        })
        return <TextFieldLine label="Find" field={field} />
      },
    }
    const { press, type } = renderApp({ screens: [screen] })
    await settle()
    await press('f')
    await type('rx')
    await press(KEYS.enter, 'r')
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
    const { frame, resize } = renderApp({ screens: [screen], size: { columns: 80, rows: 24 } })
    await settle()
    expect(frame()).toContain('80x21')
    resize({ columns: 160, rows: 40 })
    await settle()
    expect(frame()).toContain('160x37')
  })
})
