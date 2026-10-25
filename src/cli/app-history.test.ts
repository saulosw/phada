import { describe, expect, it } from 'vitest'
import { HistoryStoreError, HistoryVersionError } from '../store/history-store.js'
import type { HistoryOpening, HistoryStore } from '../store/history-store.js'
import { appHistory } from './app-history.js'

function fakeStore() {
  const store = { closed: 0, close: () => store.closed++ }
  return store
}

function opener(openings: (() => HistoryOpening)[]) {
  const calls: string[] = []
  return {
    calls,
    open: async (path: string) => {
      calls.push(path)
      const next = openings[Math.min(calls.length - 1, openings.length - 1)]
      if (next === undefined) throw new Error('no opening')
      return next()
    },
  }
}

describe('appHistory', () => {
  it('reads as missing until the file appears, then opens it once and closes it at the end', async () => {
    const store = fakeStore()
    const { calls, open } = opener([
      () => ({ status: 'missing', path: '/data/history.sqlite' }),
      () => ({ status: 'open', history: store as unknown as HistoryStore }),
    ])
    const history = appHistory('/data/history.sqlite', open)

    expect(await history.current()).toBeUndefined()
    expect(await history.current()).toBe(store)
    expect(await history.current()).toBe(store)
    expect(calls).toEqual(['/data/history.sqlite', '/data/history.sqlite'])
    history.close()
    expect(store.closed).toBe(1)
    expect(await history.current()).toBeUndefined()
    expect(calls).toHaveLength(2)
  })

  it('opens once when two screens read at the same time', async () => {
    const store = fakeStore()
    const { calls, open } = opener([
      () => ({ status: 'open', history: store as unknown as HistoryStore }),
    ])
    const history = appHistory('/h', open)

    const [first, second] = await Promise.all([history.current(), history.current()])

    expect(first).toBe(store)
    expect(second).toBe(store)
    expect(calls).toHaveLength(1)
  })

  it.each([
    [
      'newer',
      (): HistoryOpening => ({
        status: 'newer',
        path: '/h',
        error: new HistoryVersionError('/h', 9, 5),
      }),
      /newer Phada/,
    ],
    [
      'unreadable',
      (): HistoryOpening => ({
        status: 'unreadable',
        path: '/h',
        error: new HistoryStoreError('Cannot open /h: locked'),
      }),
      /Cannot open \/h: locked/,
    ],
  ])(
    'throws the error of a %s file on every read without opening it again',
    async (_case, opening, message) => {
      const { calls, open } = opener([opening])
      const history = appHistory('/h', open)

      await expect(history.current()).rejects.toThrow(message)
      await expect(history.current()).rejects.toThrow(message)
      expect(calls).toHaveLength(1)
    },
  )
})
