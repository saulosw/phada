import { describe, expect, it } from 'vitest'
import { applyFileSuggestions } from './apply-file-suggestions.js'
import type { FixItem, WorkingFiles } from './apply-file-suggestions.js'

function memoryFiles(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial))
  const reads: string[] = []
  const writes: string[] = []
  const working: WorkingFiles = {
    read: async (path) => {
      reads.push(path)
      return files.get(path)
    },
    write: async (path, text) => {
      writes.push(path)
      files.set(path, text)
    },
  }
  return { working, files, reads, writes }
}

function item(number: number, file: string, suggestion?: FixItem['finding']['suggestion']) {
  return { number, finding: { file, ...(suggestion === undefined ? {} : { suggestion }) } }
}

describe('applyFileSuggestions', () => {
  it('leaves a finding with no suggestion without reading its file', async () => {
    const disk = memoryFiles({ 'a.ts': 'one\n' })
    const plain = item(1, 'a.ts')

    expect(await applyFileSuggestions([plain], disk.working)).toEqual({
      applied: [],
      left: [{ item: plain, reason: 'no-suggestion' }],
    })
    expect(disk.reads).toEqual([])
    expect(disk.writes).toEqual([])
  })

  it('leaves every suggestion of a file the working tree does not have', async () => {
    const disk = memoryFiles({})
    const first = item(1, 'gone.ts', { startLine: 1, endLine: 1, replacement: 'x' })
    const second = item(2, 'gone.ts', { startLine: 2, endLine: 2, replacement: 'y' })

    expect(await applyFileSuggestions([first, second], disk.working)).toEqual({
      applied: [],
      left: [
        { item: first, reason: 'missing-file' },
        { item: second, reason: 'missing-file' },
      ],
    })
    expect(disk.reads).toEqual(['gone.ts'])
  })

  it('reads and writes each file once with all its suggestions, and sorts the results by number', async () => {
    const disk = memoryFiles({ 'a.ts': 'one\ntwo\nthree\n', 'b.ts': 'alpha\n' })
    const bFirst = item(1, 'b.ts', {
      startLine: 1,
      endLine: 1,
      original: 'alpha',
      replacement: 'ALPHA',
    })
    const aThird = item(2, 'a.ts', {
      startLine: 3,
      endLine: 3,
      original: 'three',
      replacement: 'THREE',
    })
    const plain = item(3, 'a.ts')
    const aFirst = item(4, 'a.ts', {
      startLine: 1,
      endLine: 1,
      original: 'one',
      replacement: 'ONE',
    })

    const result = await applyFileSuggestions([aFirst, plain, bFirst, aThird], disk.working)

    expect(result).toEqual({
      applied: [bFirst, aThird, aFirst],
      left: [{ item: plain, reason: 'no-suggestion' }],
    })
    expect(disk.reads).toEqual(['a.ts', 'b.ts'])
    expect(disk.writes).toEqual(['a.ts', 'b.ts'])
    expect(disk.files.get('a.ts')).toBe('ONE\ntwo\nTHREE\n')
    expect(disk.files.get('b.ts')).toBe('ALPHA\n')
  })

  it('does not write a file none of whose suggestions applied', async () => {
    const disk = memoryFiles({ 'a.ts': 'one\n' })
    const stale = item(1, 'a.ts', { startLine: 1, endLine: 1, original: 'zero', replacement: 'x' })

    expect(await applyFileSuggestions([stale], disk.working)).toEqual({
      applied: [],
      left: [{ item: stale, reason: 'not-found' }],
    })
    expect(disk.writes).toEqual([])
  })
})
