import { describe, expect, it } from 'vitest'
import { dataFiles, phadaDataDir } from './data-paths.js'

describe('phadaDataDir', () => {
  it.each([
    [{ PHADA_DATA_HOME: '/data', XDG_DATA_HOME: '/xdg' }, '/data'],
    [{ XDG_DATA_HOME: '/xdg' }, '/xdg/phada'],
    [{}, '/home/u/.local/share/phada'],
    [{ PHADA_DATA_HOME: ' ', XDG_DATA_HOME: '' }, '/home/u/.local/share/phada'],
  ])('resolves %o', (env, dir) => {
    expect(phadaDataDir(env, '/home/u')).toBe(dir)
  })
})

describe('dataFiles', () => {
  it('keeps the history and the watch lock in the data folder', () => {
    expect(dataFiles({ PHADA_DATA_HOME: '/data' }, '/home/u')).toEqual({
      history: '/data/history.sqlite',
      lock: '/data/watch.lock',
    })
  })
})
