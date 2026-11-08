import { describe, expect, it } from 'vitest'
import { applySuggestions } from './apply-suggestions.js'
import type { SuggestedEdit } from './types.js'

interface Item {
  name: string
  suggestion: SuggestedEdit
}

function item(name: string, suggestion: SuggestedEdit): Item {
  return { name, suggestion }
}

const FILE = ['const LIMIT = 10', 'const FEE = 1', '', 'export function spend() {', '}', ''].join(
  '\n',
)

describe('applySuggestions', () => {
  it('replaces the lines of the range when they hold the original', () => {
    const limit = item('limit', {
      startLine: 1,
      endLine: 1,
      original: 'const LIMIT = 10',
      replacement: 'const LIMIT = 20',
    })

    const result = applySuggestions(FILE, [limit])

    expect(result.text).toBe(
      ['const LIMIT = 20', 'const FEE = 1', '', 'export function spend() {', '}', ''].join('\n'),
    )
    expect(result.applied).toEqual([limit])
    expect(result.refused).toEqual([])
  })

  it('applies at the one place the original moved to when the range no longer holds it', () => {
    const fee = item('fee', {
      startLine: 1,
      endLine: 1,
      original: 'const FEE = 1',
      replacement: 'const FEE = 2',
    })

    const result = applySuggestions(FILE, [fee])

    expect(result.text).toBe(
      ['const LIMIT = 10', 'const FEE = 2', '', 'export function spend() {', '}', ''].join('\n'),
    )
    expect(result.applied).toEqual([fee])
  })

  it('refuses an original the file no longer holds', () => {
    const gone = item('gone', {
      startLine: 1,
      endLine: 1,
      original: 'const LIMIT = 5',
      replacement: 'const LIMIT = 20',
    })

    const result = applySuggestions(FILE, [gone])

    expect(result.text).toBe(FILE)
    expect(result.applied).toEqual([])
    expect(result.refused).toEqual([{ item: gone, reason: 'not-found' }])
  })

  it('refuses an original the file holds in more than one place outside the range', () => {
    const file = ['const A = 1', '  return x', 'const B = 2', '  return x', ''].join('\n')
    const twice = item('twice', {
      startLine: 1,
      endLine: 1,
      original: '  return x',
      replacement: '  return y',
    })

    const result = applySuggestions(file, [twice])

    expect(result.text).toBe(file)
    expect(result.refused).toEqual([{ item: twice, reason: 'ambiguous' }])
  })

  it('keeps the first of two suggestions that touch the same lines and refuses the next', () => {
    const both = item('both', {
      startLine: 1,
      endLine: 2,
      original: 'const LIMIT = 10\nconst FEE = 1',
      replacement: 'const LIMIT = 20\nconst FEE = 2',
    })
    const fee = item('fee', {
      startLine: 2,
      endLine: 2,
      original: 'const FEE = 1',
      replacement: 'const FEE = 3',
    })

    const result = applySuggestions(FILE, [both, fee])

    expect(result.text).toBe(
      ['const LIMIT = 20', 'const FEE = 2', '', 'export function spend() {', '}', ''].join('\n'),
    )
    expect(result.applied).toEqual([both])
    expect(result.refused).toEqual([{ item: fee, reason: 'overlap' }])
  })

  it('places every suggestion by the lines of the file it was given', () => {
    const limit = item('limit', {
      startLine: 1,
      endLine: 1,
      original: 'const LIMIT = 10',
      replacement: '',
    })
    const spend = item('spend', {
      startLine: 4,
      endLine: 4,
      original: 'export function spend() {',
      replacement: 'export function spend(amount: number) {\n  check(amount)',
    })

    const result = applySuggestions(FILE, [spend, limit])

    expect(result.text).toBe(
      [
        'const FEE = 1',
        '',
        'export function spend(amount: number) {',
        '  check(amount)',
        '}',
        '',
      ].join('\n'),
    )
    expect(result.applied).toEqual([spend, limit])
  })

  it('keeps the CRLF line endings of the file', () => {
    const file = ['const LIMIT = 10', 'const FEE = 1', ''].join('\r\n')
    const limit = item('limit', {
      startLine: 1,
      endLine: 1,
      original: 'const LIMIT = 10\n',
      replacement: 'const LIMIT = 20\nconst MAX = 30\n',
    })

    const result = applySuggestions(file, [limit])

    expect(result.text).toBe(
      ['const LIMIT = 20', 'const MAX = 30', 'const FEE = 1', ''].join('\r\n'),
    )
  })

  it('keeps a file without a final newline without one', () => {
    const file = 'const LIMIT = 10\nconst FEE = 1'
    const fee = item('fee', {
      startLine: 2,
      endLine: 2,
      original: 'const FEE = 1',
      replacement: 'const FEE = 2',
    })

    expect(applySuggestions(file, [fee]).text).toBe('const LIMIT = 10\nconst FEE = 2')
  })

  it('replaces only the lines of the original when the range is longer than it', () => {
    const limit = item('limit', {
      startLine: 1,
      endLine: 2,
      original: 'const LIMIT = 10',
      replacement: 'const LIMIT = 20',
    })

    const result = applySuggestions(FILE, [limit])

    expect(result.text).toBe(
      ['const LIMIT = 20', 'const FEE = 1', '', 'export function spend() {', '}', ''].join('\n'),
    )
  })

  it('applies a suggestion without an original at its range', () => {
    const spend = item('spend', {
      startLine: 4,
      endLine: 5,
      replacement: 'export function spend() {\n  return 0\n}',
    })

    const result = applySuggestions(FILE, [spend])

    expect(result.text).toBe(
      [
        'const LIMIT = 10',
        'const FEE = 1',
        '',
        'export function spend() {',
        '  return 0',
        '}',
        '',
      ].join('\n'),
    )
    expect(result.applied).toEqual([spend])
  })

  it('refuses a range past the last line of the file', () => {
    const past = item('past', { startLine: 5, endLine: 6, replacement: '}' })

    const result = applySuggestions(FILE, [past])

    expect(result.text).toBe(FILE)
    expect(result.refused).toEqual([{ item: past, reason: 'not-found' }])
  })

  it('finds an empty original only among the lines of the file', () => {
    const blank = item('blank', { startLine: 1, endLine: 1, original: '', replacement: '// spend' })

    const result = applySuggestions(FILE, [blank])

    expect(result.text).toBe(
      ['const LIMIT = 10', 'const FEE = 1', '// spend', 'export function spend() {', '}', ''].join(
        '\n',
      ),
    )
  })
})
