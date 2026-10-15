import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { indexFile, mirrorDir, pathSize, phadaCacheDir, repositoryCache } from './cache-paths.js'

describe('phadaCacheDir', () => {
  it('prefers PHADA_CACHE_HOME, then XDG_CACHE_HOME, then ~/.cache', () => {
    expect(phadaCacheDir({ PHADA_CACHE_HOME: '/p', XDG_CACHE_HOME: '/x' }, '/home/u')).toBe('/p')
    expect(phadaCacheDir({ XDG_CACHE_HOME: '/x' }, '/home/u')).toBe('/x/phada')
    expect(phadaCacheDir({}, '/home/u')).toBe('/home/u/.cache/phada')
  })

  it('ignores values made of spaces', () => {
    expect(phadaCacheDir({ PHADA_CACHE_HOME: ' ', XDG_CACHE_HOME: '  ' }, '/home/u')).toBe(
      '/home/u/.cache/phada',
    )
  })
})

describe('mirrorDir and indexFile', () => {
  it('place each repository under its lowercase owner and name', () => {
    expect(mirrorDir('/c', 'Acme', 'Shop')).toBe('/c/repos/acme/shop.git')
    expect(indexFile('/c', 'Acme', 'Shop')).toBe('/c/index/acme/shop.sqlite')
  })
})

describe('pathSize', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phada-size-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('adds up the files of a folder and its subfolders', async () => {
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'a'), 'abc')
    writeFileSync(join(dir, 'sub', 'b'), 'abcde')

    expect(await pathSize(dir)).toBe(8)
  })

  it('returns the size of a single file and 0 for a missing path', async () => {
    expect(await pathSize(join(dir, 'a'))).toBe(3)
    expect(await pathSize(join(dir, 'missing'))).toBe(0)
  })
})

describe('repositoryCache', () => {
  it('gives the mirror and the index of a repository in the cache folder', () => {
    expect(repositoryCache({ PHADA_CACHE_HOME: '/c' }, '/home/u', 'Acme', 'Shop')).toEqual({
      mirror: '/c/repos/acme/shop.git',
      index: '/c/index/acme/shop.sqlite',
      observed: '/c/observed/acme/shop.sqlite',
    })
    expect(repositoryCache({}, '/home/u', 'acme', 'shop').mirror).toBe(
      '/home/u/.cache/phada/repos/acme/shop.git',
    )
  })
})
