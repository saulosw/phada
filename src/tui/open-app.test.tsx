import { cleanup, render } from 'ink-testing-library'
import { cloneElement, isValidElement } from 'react'
import { Text } from 'ink'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeAppDeps, waitFor, writeKeys } from '../../test/support/tui.js'
import type { AppProps } from './app.js'
import { useQuitGuard } from './app-context.js'
import type { AppDeps } from './app-context.js'
import { openApp } from './open-app.js'
import { QueueScreen } from './screens/queue.js'
import type { AppHost, StopSignal } from './open-app.js'
import type { ScreenDefinition } from './screens.js'

const DEPS: AppDeps = fakeAppDeps(
  { every: () => () => {} },
  { version: '1.2.3', cwd: '/home/ana/shop', home: '/home/ana', env: {} },
)

function host(options: { screens?: readonly ScreenDefinition[] } = {}) {
  const calls: string[] = []
  const signals: ((signal?: StopSignal) => void)[] = []
  let renderedOptions: unknown
  let stdin: ReturnType<typeof render>['stdin'] | undefined
  let frame = () => ''
  let exit = () => {}
  const exited = new Promise<void>((resolve) => {
    exit = resolve
  })
  const appHost: AppHost = {
    stdin: {} as NodeJS.ReadStream,
    stdout: {} as NodeJS.WriteStream,
    size: { current: () => ({ columns: 100, rows: 30 }), subscribe: () => () => {} },
    onSignal: (handler) => signals.push(handler),
    render: (node, renderOptions) => {
      renderedOptions = renderOptions
      if (!isValidElement<AppProps>(node)) throw new Error('openApp rendered no element')
      const app = render(
        options.screens === undefined ? node : cloneElement(node, { screens: options.screens }),
      )
      stdin = app.stdin
      frame = () => app.lastFrame() ?? ''
      return {
        unmount: () => {
          calls.push('unmount')
          app.unmount()
          exit()
        },
        waitUntilExit: () => exited,
      }
    },
  }
  return {
    appHost,
    calls,
    signal: (signal?: StopSignal) => signals.forEach((handler) => handler(signal)),
    mounted: () => waitFor(() => (stdin?.listenerCount('readable') ?? 0) > 0),
    press: async (key: string) => {
      if (stdin !== undefined) await writeKeys(stdin, [key])
    },
    renderedOptions: () => renderedOptions,
    showing: (text: string) => waitFor(() => frame().includes(text)),
    frame: () => frame(),
  }
}

afterEach(() => cleanup())

describe('openApp', () => {
  it('renders on the alternate screen and handles Ctrl-C itself', async () => {
    const fake = host()
    const result = openApp(DEPS, fake.appHost)
    await fake.mounted()
    await fake.press('q')
    await result
    expect(fake.renderedOptions()).toMatchObject({ alternateScreen: true, exitOnCtrlC: false })
  })

  it('unmounts and quits on q', async () => {
    const fake = host()
    const result = openApp(DEPS, fake.appHost)
    await fake.mounted()
    await fake.press('q')
    expect(await result).toEqual({ kind: 'quit' })
    expect(fake.calls).toEqual(['unmount'])
  })

  it('unmounts and stops as interrupted on Ctrl-C', async () => {
    const fake = host()
    const result = openApp(DEPS, fake.appHost)
    await fake.mounted()
    await fake.press('\u0003')
    expect(await result).toEqual({ kind: 'interrupted' })
    expect(fake.calls).toEqual(['unmount'])
  })

  it.each([
    ['SIGTERM', { kind: 'terminated' }],
    ['SIGINT', { kind: 'interrupted' }],
  ] as const)('unmounts on %s', async (signal, expected) => {
    const fake = host()
    const result = openApp(DEPS, fake.appHost)
    await fake.mounted()
    fake.signal(signal)
    fake.signal(signal)
    expect(await result).toEqual(expected)
    expect(fake.calls).toEqual(['unmount'])
  })

  it.each([
    ['SIGTERM', { kind: 'terminated' }],
    ['SIGINT', { kind: 'interrupted' }],
  ] as const)('aborts what runs on %s without asking and unmounts', async (signal, expected) => {
    const calls: string[] = []
    const fake = host({
      screens: [
        {
          id: 'home',
          title: (messages) => messages.screens.home,
          Screen: () => {
            useQuitGuard({
              question: 'A job is running: stop it and quit?',
              stop: () => {
                calls.push('stop')
              },
              abort: () => calls.push('abort'),
            })
            return <Text>working</Text>
          },
        },
      ],
    })
    const result = openApp(DEPS, fake.appHost)
    await fake.mounted()
    fake.signal(signal)
    expect(await result).toEqual(expected)
    expect(calls).toEqual(['abort'])
    expect(fake.calls).toEqual(['unmount'])
  })

  it('aborts the watch running in the app on SIGTERM and gives the terminal back', async () => {
    const calls: string[] = []
    const fake = host({
      screens: [{ id: 'queue', title: (messages) => messages.screens.queue, Screen: QueueScreen }],
    })
    const deps: AppDeps = {
      ...DEPS,
      startWatch: async () => {
        calls.push('start')
        return {
          status: 'started',
          control: {
            done: new Promise(() => {}),
            stop: () => calls.push('stop'),
            abort: () => calls.push('abort'),
          },
        }
      },
    }
    const result = openApp(deps, fake.appHost)
    await fake.mounted()
    await fake.press('w')
    await fake.showing('Watch running in this app')
    expect(fake.frame()).toContain('Watch running in this app')

    fake.signal('SIGTERM')

    expect(await result).toEqual({ kind: 'terminated' })
    expect(calls).toEqual(['start', 'abort'])
    expect(fake.calls).toEqual(['unmount'])
  })

  it('asks before quitting on Ctrl-C while something runs, and a second one stops as interrupted', async () => {
    const calls: string[] = []
    const fake = host({
      screens: [
        {
          id: 'home',
          title: (messages) => messages.screens.home,
          Screen: () => {
            useQuitGuard({
              question: 'A job is running: stop it and quit?',
              stop: () => {
                calls.push('stop')
              },
              abort: () => calls.push('abort'),
            })
            return <Text>working</Text>
          },
        },
      ],
    })
    const result = openApp(DEPS, fake.appHost)
    await fake.mounted()
    await fake.press('\u0003')
    expect(fake.calls).toEqual([])
    await fake.press('\u0003')
    expect(await result).toEqual({ kind: 'interrupted' })
    expect(calls).toEqual(['abort'])
    expect(fake.calls).toEqual(['unmount'])
  })

  it('unmounts and hands back the error a screen threw', async () => {
    const failure = new Error('the history answered nonsense')
    const fake = host({
      screens: [
        {
          id: 'broken',
          title: () => ({ full: 'Broken', short: 'Broken' }),
          Screen: () => {
            throw failure
          },
        },
      ],
    })
    const result = await openApp(DEPS, fake.appHost)
    expect(result).toEqual({ kind: 'failed', error: failure })
    expect(fake.calls).toEqual(['unmount'])
  })

  it('hands back an error of the render itself', async () => {
    const failure = new Error('no raw mode')
    const result = await openApp(DEPS, {
      ...host().appHost,
      render: () => {
        throw failure
      },
    })
    expect(result).toEqual({ kind: 'failed', error: failure })
  })
})
