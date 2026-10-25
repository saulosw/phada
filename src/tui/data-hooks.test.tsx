import { Text } from 'ink'
import { cleanup, render } from 'ink-testing-library'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeAppDeps } from '../../test/support/tui.js'
import { App } from './app.js'
import type { AppDeps, Scheduler } from './app-context.js'
import { POLL_MS, usePolled, useLoaded } from './data-hooks.js'
import { DataView } from './data-view.js'
import type { ScreenDefinition } from './screens.js'

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

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
    expect(intervals()).toEqual([2000])
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
    expect(intervals()).toEqual([2000])
  })
})

describe('useLoaded', () => {
  it('shows the loading state, the value, and loads again on r', async () => {
    const pending: ((value: string) => void)[] = []
    const { frame, press } = openScreen(() => {
      const { state } = useLoaded(() => new Promise<string>((resolve) => pending.push(resolve)))
      return <DataView state={state}>{(value) => <Text>repos {value}</Text>}</DataView>
    })
    await settle()
    expect(frame()).toContain('Loading…')
    pending.shift()?.('3')
    await settle()
    expect(frame()).toContain('repos 3')
    await press('r')
    expect(frame()).toContain('Loading…')
    pending.shift()?.('4')
    await settle()
    expect(frame()).toContain('repos 4')
  })

  it('shows a failed load without stopping the app', async () => {
    const { frame } = openScreen(() => {
      const { state } = useLoaded(() => Promise.reject(new Error('GitHub answered 503')))
      return <DataView state={state}>{(value) => <Text>{String(value)}</Text>}</DataView>
    })
    await settle()
    expect(frame()).toContain('Could not load: GitHub answered 503')
  })
})
