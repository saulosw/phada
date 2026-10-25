import { describe, expect, it } from 'vitest'
import { colorLevel, resolveTheme } from './theme.js'

describe('colorLevel', () => {
  it.each([
    [{}, '16'],
    [{ TERM: 'xterm' }, '16'],
    [{ TERM: 'xterm-256color' }, '256'],
    [{ TERM: 'screen-256color', COLORTERM: 'truecolor' }, 'truecolor'],
    [{ COLORTERM: '24bit' }, 'truecolor'],
    [{ COLORTERM: 'yes', TERM: 'xterm' }, '16'],
    [{ TERM: 'dumb', COLORTERM: 'truecolor' }, 'none'],
    [{ NO_COLOR: '1', COLORTERM: 'truecolor' }, 'none'],
    [{ NO_COLOR: '', TERM: 'xterm-256color' }, '256'],
    [{ NO_COLOR: '1', FORCE_COLOR: '3' }, 'none'],
    [{ FORCE_COLOR: '0', COLORTERM: 'truecolor' }, 'none'],
    [{ FORCE_COLOR: '1', COLORTERM: 'truecolor' }, '16'],
    [{ FORCE_COLOR: '2', TERM: 'dumb' }, '256'],
    [{ FORCE_COLOR: '3', TERM: 'xterm' }, 'truecolor'],
    [{ FORCE_COLOR: 'true', TERM: 'xterm-256color' }, '256'],
    [{ FORCE_COLOR: '', COLORTERM: 'truecolor' }, 'truecolor'],
  ])('reads %j as %s', (env, level) => {
    expect(colorLevel(env)).toBe(level)
  })
})

describe('resolveTheme', () => {
  it('keeps the Violeta hex colors in truecolor', () => {
    expect(resolveTheme('truecolor').colors).toMatchObject({
      accent: '#8B5CF6',
      soft: '#C4B5FD',
      dim: '#7C6F9B',
    })
  })

  it('takes the nearest xterm-256 color in 256 colors', () => {
    expect(resolveTheme('256').colors).toMatchObject({
      accent: 'ansi256(99)',
      soft: 'ansi256(183)',
    })
  })

  it('names one of the 16 colors in 16 colors', () => {
    expect(resolveTheme('16').colors).toEqual({
      accent: 'magentaBright',
      soft: 'magenta',
      dim: 'gray',
      ok: 'green',
      warn: 'yellow',
      error: 'red',
      info: 'cyan',
    })
  })

  it('leaves every color out without color', () => {
    expect(resolveTheme('none')).toEqual({ level: 'none', colors: {} })
  })
})
