import { Text } from 'ink'
import { cleanup, render } from 'ink-testing-library'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeAppDeps, NOW, renderApp, waitFor } from '../../test/support/tui.js'
import { App } from './app.js'
import { useIsWorking } from './app-context.js'
import type { AppDeps, Scheduler } from './app-context.js'
import { FRESH_MS, POLL_MS, usePolled, useLoaded } from './data-hooks.js'
import { DataView } from './data-view.js'
import type { ScreenDefinition } from './screens.js'

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))
const LANGUAGE_AND_SCREEN_POLLS = [POLL_MS, POLL_MS]

function openScreen(Screen: () => ReactNode) {
  const ticks: { ms: number; tick: () => void }[] = []
  const scheduler: Scheduler = {
    every: (ms, tick) => {
      const entry = { ms, tick }
      ticks.push(entry)
      return () => ticks.splice(ticks.indexOf(entry), 1)
    },
  }
  const deps: AppDeps = fakeAppDeps(scheduler, { version: '1.0.0', cwd: '/', home: '/h', env: {} })
  const screens: ScreenDefinition[] = [
    { id: 'data', title: () => ({ full: 'Data', short: 'Data' }), Screen },
  ]
  const app = render(
    <App
      deps={deps}
      size={{ current: () => ({ columns: 100, rows: 30 }), subscribe: () => () => {} }}
      screens={screens}
      onExit={() => {}}
    />,
  )
  return {
    frame: () => app.lastFrame() ?? '',
    tick: () => {
      for (const { tick } of [...ticks]) tick()
    },
    intervals: () => ticks.map(({ ms }) => ms),
    press: async (key: string) => {
      app.stdin.write(key)
      await settle()
    },
  }
}

afterEach(() => cleanup())

describe('usePolled', () => {
  it('reads at once, then on every tick of 2 s, and shows a failed read on screen', async () => {
    const answers: (() => string)[] = [
      () => 'first',
      () => 'second',
      () => {
        throw new Error('history is locked')
      },
      () => 'back',
    ]
    const { frame, tick, intervals } = openScreen(() => {
      const state = usePolled(() => (answers.shift() ?? (() => 'end'))())
      return <DataView state={state}>{(value) => <Text>value {value}</Text>}</DataView>
    })
    await settle()
    expect(frame()).toContain('value first')
    expect(intervals()).toEqual(LANGUAGE_AND_SCREEN_POLLS)
    tick()
    await settle()
    expect(frame()).toContain('value second')
    tick()
    await settle()
    expect(frame()).toContain('Could not load: history is locked')
    tick()
    await settle()
    expect(frame()).toContain('value back')
  })
})

describe('usePolled with a key', () => {
  it('reads again at once when the key changes, keeping the last value meanwhile', async () => {
    const reads: string[] = []
    let setKey = (_key: string) => {}
    const { frame, intervals } = openScreen(() => {
      const [key, update] = useState('a')
      setKey = update
      const state = usePolled(
        () => {
          reads.push(key)
          return key
        },
        POLL_MS,
        key,
      )
      return <DataView state={state}>{(value) => <Text>value {value}</Text>}</DataView>
    })
    await settle()
    expect(frame()).toContain('value a')
    setKey('b')
    await settle()
    expect(frame()).toContain('value b')
    expect(reads).toEqual(['a', 'b'])
    expect(intervals()).toEqual(LANGUAGE_AND_SCREEN_POLLS)
  })
})

describe('useLoaded', () => {
  it('shows the loading state, the value, and loads again on r keeping the value meanwhile', async () => {
    const pending: ((value: string) => void)[] = []
    const { frame, press } = openScreen(() => {
      const { state } = useLoaded(
        'repos',
        () => new Promise<string>((resolve) => pending.push(resolve)),
      )
      const working = useIsWorking()
      return (
        <>
          <DataView state={state}>{(value) => <Text>repos {value}</Text>}</DataView>
          <Text>{working ? 'busy' : 'idle'}</Text>
        </>
      )
    })
    await settle()
    expect(frame()).toContain('Loading…')
    pending.shift()?.('3')
    await settle()
    expect(frame()).toContain('repos 3')
    expect(frame()).toContain('idle')
    await press('r')
    expect(frame()).toContain('repos 3')
    expect(frame()).toContain('busy')
    pending.shift()?.('4')
    await settle()
    expect(frame()).toContain('repos 4')
    expect(frame()).toContain('idle')
  })

  it('shows a failed load without stopping the app', async () => {
    const { frame } = openScreen(() => {
      const { state } = useLoaded('github', () => Promise.reject(new Error('GitHub answered 503')))
      return <DataView state={state}>{(value) => <Text>{String(value)}</Text>}</DataView>
    })
    await settle()
    expect(frame()).toContain('Could not load: GitHub answered 503')
  })

  it('shows a failed load on one line, without the control characters of the error', async () => {
    const { frame } = openScreen(() => {
      const { state } = useLoaded('github', () =>
        Promise.reject(new Error('GitHub answered 503:\n  <html>\u001B[2J\u202Edown')),
      )
      return <DataView state={state}>{(value) => <Text>{String(value)}</Text>}</DataView>
    })
    await settle()
    expect(frame()).toContain('Could not load: GitHub answered 503: <html>[2Jdown')
    expect(frame()).not.toMatch(/[\u001B\u202E]/)
  })
})

describe('slow loads cached in the app', () => {
  function cached() {
    const pending: ((value: string) => void)[] = []
    let loads = 0
    const load = () => {
      loads += 1
      return new Promise<string>((resolve) => pending.push(resolve))
    }
    const screen = (id: string): ScreenDefinition => ({
      id,
      title: () => ({ full: id, short: id }),
      Screen: () => {
        const { state } = useLoaded('facts', load)
        const working = useIsWorking()
        return (
          <>
            <DataView state={state}>{(value) => <Text>{`${id} has ${value}`}</Text>}</DataView>
            <Text>{working ? 'busy' : 'idle'}</Text>
          </>
        )
      },
    })
    let now = NOW.getTime()
    const rendered = renderApp({
      screens: [screen('first'), screen('second')],
      size: { columns: 80, rows: 24 },
      deps: { now: () => new Date(now) },
    })
    return {
      ...rendered,
      loads: () => loads,
      resolve: (value: string) => pending.shift()?.(value),
      later: (ms: number) => {
        now += ms
      },
    }
  }

  it('shares the last value between screens and does not load it again within 30 s, even across a resize', async () => {
    const app = cached()
    await settle()
    app.resolve('one')
    await waitFor(() => app.frame().includes('first has one'))
    await app.press('2')
    expect(app.frame()).toContain('second has one')
    expect(app.frame()).toContain('idle')
    app.later(FRESH_MS - 1000)
    app.resize({ columns: 70, rows: 20 })
    await settle()
    app.resize({ columns: 80, rows: 24 })
    await settle()
    await app.press('1')
    expect(app.frame()).toContain('first has one')
    expect(app.loads()).toBe(1)
  })

  it('shows the last value at once and loads it again in the background after 30 s', async () => {
    const app = cached()
    await settle()
    app.resolve('one')
    await waitFor(() => app.frame().includes('first has one'))
    app.later(FRESH_MS + 1000)
    await app.press('2')
    expect(app.frame()).toContain('second has one')
    expect(app.frame()).toContain('busy')
    expect(app.loads()).toBe(2)
    app.resolve('two')
    await waitFor(() => app.frame().includes('second has two'))
    expect(app.frame()).toContain('idle')
  })

  it('joins a load still running instead of starting another, and r always loads again', async () => {
    const app = cached()
    await settle()
    await app.press('2')
    expect(app.loads()).toBe(1)
    app.resolve('one')
    await waitFor(() => app.frame().includes('second has one'))
    await app.press('r')
    expect(app.loads()).toBe(2)
    expect(app.frame()).toContain('second has one')
    app.resolve('two')
    await waitFor(() => app.frame().includes('second has two'))
  })
})
