import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  indexFile,
  mirrorDir,
  observedFile,
  observedRepositories,
  pathSize,
  phadaCacheDir,
  repositoryCache,
} from './cache-paths.js'

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

describe('observedRepositories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phada-observed-list-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('lists the repositories with an observed file, and none without the folder', async () => {
    expect(await observedRepositories(dir)).toEqual([])
    mkdirSync(join(dir, 'observed', 'acme'), { recursive: true })
    mkdirSync(join(dir, 'observed', 'zeta'), { recursive: true })
    writeFileSync(join(dir, 'observed', 'acme', 'web.sqlite'), '')
    writeFileSync(join(dir, 'observed', 'acme', 'shop.sqlite'), '')
    writeFileSync(join(dir, 'observed', 'acme', 'shop.sqlite-wal'), '')
    writeFileSync(join(dir, 'observed', 'zeta', 'notes.txt'), '')
    writeFileSync(join(dir, 'observed', 'stray.sqlite'), '')

    expect(await observedRepositories(dir)).toEqual(['acme/shop', 'acme/web'])
  })

  it('lists the repository of each file observedFile() names', async () => {
    const cache = join(dir, 'named')
    const path = observedFile(cache, 'Octo', 'Api')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '')

    expect(path).toBe(join(cache, 'observed', 'octo', 'api.sqlite'))
    expect(await observedRepositories(cache)).toEqual(['octo/api'])
  })
})
