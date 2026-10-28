import { Box } from 'ink'
import { cleanup, render } from 'ink-testing-library'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { failedNodes, Lines, spaced, textLines } from './frame-lines.js'
import { uiMessagesFor } from './i18n/messages.js'
import { ERROR_LINES } from './text-fit.js'
import { resolveTheme } from './theme.js'

afterEach(() => cleanup())

const draw = { messages: uiMessagesFor('en'), theme: resolveTheme('none'), width: 20 }

function shown(lines: readonly ReactNode[]): string[] {
  const { lastFrame } = render(
    <Box width={draw.width}>
      <Lines lines={lines} />
    </Box>,
  )
  return (lastFrame() ?? '').split('\n').map((line) => line.trimEnd())
}

describe('textLines', () => {
  it('wraps a text at the width, one node per line', () => {
    const lines = textLines('one two three four five six', 10)

    expect(lines).toHaveLength(3)
    expect(shown(lines)).toEqual(['one two', 'three four', 'five six'])
  })
})

describe('failedNodes', () => {
  it('shows any error as the failed message over a few lines at most', () => {
    const lines = failedNodes(draw, new Error(`broken ${'word '.repeat(40)}`))

    expect(lines).toHaveLength(ERROR_LINES)
    expect(shown(lines)[0]).toBe('Could not load:')
  })
})

describe('spaced', () => {
  it('puts a blank line before lines, and nothing before none', () => {
    expect(spaced([])).toEqual([])
    expect(shown(spaced(textLines('after', 20)))).toEqual(['', 'after'])
  })
})

describe('Lines', () => {
  it('cuts a line longer than the width instead of wrapping it', () => {
    expect(shown(['a line much longer than twenty columns'])).toEqual(['a line much longer …'])
  })
})
