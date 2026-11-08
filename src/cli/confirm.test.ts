import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { confirm, isTerminalInput } from './confirm.js'

function output() {
  const written: string[] = []
  return { write: (text: string) => written.push(text), text: () => written.join('') }
}

describe('confirm', () => {
  it.each([
    ['y\n', true],
    ['yes\n', true],
    ['  YES  \n', true],
    ['Y\n', true],
    ['n\n', false],
    ['no\n', false],
    ['\n', false],
    ['yep\n', false],
  ])('answers %j as %s', async (typed, answer) => {
    expect(await confirm(Readable.from([typed]), output(), 'Go? ')).toBe(answer)
  })

  it('reads only the first line', async () => {
    expect(await confirm(Readable.from(['n\ny\n']), output(), 'Go? ')).toBe(false)
  })

  it('answers no at the end of the input', async () => {
    expect(await confirm(Readable.from([]), output(), 'Go? ')).toBe(false)
  })

  it('writes the question as it is', async () => {
    const out = output()

    await confirm(Readable.from(['y\n']), out, 'Commit and push? [y/N] ')

    expect(out.text()).toBe('Commit and push? [y/N] ')
  })
})

describe('isTerminalInput', () => {
  it('is true only for a stream that says it is a terminal', () => {
    const terminal = Object.assign(Readable.from([]), { isTTY: true })
    const piped = Object.assign(Readable.from([]), { isTTY: false })

    expect(isTerminalInput(terminal)).toBe(true)
    expect(isTerminalInput(piped)).toBe(false)
    expect(isTerminalInput(Readable.from([]))).toBe(false)
  })
})
