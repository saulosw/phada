import { describe, expect, it } from 'vitest'
import { createExtractor } from '../repo-map/extract.js'
import { codeElements } from './code-elements.js'
import { comparedCommits } from './harvest-misses.js'

const SHA = 'c'.repeat(40)

describe('codeElements', () => {
  it('reads a file again after a read of it failed', async () => {
    let reads = 0
    const elements = codeElements(async () => {
      reads++
      if (reads === 1) throw new Error('Server error')
      return 'export function spend(): void {\n  return\n}\n'
    }, createExtractor())

    await expect(elements('acme/shop', SHA, 'src/shop.ts')).rejects.toThrow('Server error')
    expect(await elements('acme/shop', SHA, 'src/shop.ts')).toEqual([{ startLine: 1, endLine: 3 }])
    expect(await elements('acme/shop', SHA, 'src/shop.ts')).toEqual([{ startLine: 1, endLine: 3 }])
    expect(reads).toBe(2)
  })
})

describe('comparedCommits', () => {
  it('compares again after a comparison failed', async () => {
    let calls = 0
    const compare = comparedCommits(async () => {
      calls++
      if (calls === 1) throw new Error('Server error')
      return []
    })

    await expect(compare('acme/shop', 'a', 'b')).rejects.toThrow('Server error')
    expect(await compare('acme/shop', 'a', 'b')).toEqual([])
    expect(await compare('acme/shop', 'a', 'b')).toEqual([])
    expect(calls).toBe(2)
  })
})
