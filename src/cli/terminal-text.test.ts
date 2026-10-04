import { describe, expect, it } from 'vitest'
import { toTerminalText } from './terminal-text.js'

describe('toTerminalText', () => {
  it.each([
    ['an ANSI escape sequence', 'safe\u001B[2Jtext', 'safe[2Jtext'],
    ['an 8-bit CSI', 'safe\u009B2Jtext', 'safe2Jtext'],
    ['a bell', 'ding\u0007', 'ding'],
    ['a carriage return', 'line one\r\nline two', 'line one\nline two'],
    ['a delete character', 'oops\u007F', 'oops'],
    ['a NUL', 'a\u0000b', 'ab'],
    ['a right-to-left override', 'admin\u202Etxt.exe', 'admintxt.exe'],
    ['a bidi isolate', '\u2066evil\u2069', 'evil'],
  ])('removes %s', (_case, input, expected) => {
    expect(toTerminalText(input)).toBe(expected)
  })

  it('keeps line breaks, tabs and unicode text', () => {
    expect(toTerminalText('a\tb\nção → ✓')).toBe('a\tb\nção → ✓')
  })
})
