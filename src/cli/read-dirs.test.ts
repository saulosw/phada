import { describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { readDirResolver } from './read-dirs.js'

describe('readDirResolver', () => {
  const files = memoryFiles({ '/home/u/rules/a.md': 'x', '/srv/docs/b.md': 'y' })
  const resolve = readDirResolver(files, '/home/u')

  it('expands ~ and keeps existing folders', async () => {
    expect(await resolve('~/rules')).toBe('/home/u/rules')
    expect(await resolve('/srv/docs')).toBe('/srv/docs')
  })

  it('drops a folder that does not exist', async () => {
    expect(await resolve('/nope')).toBeUndefined()
  })
})
