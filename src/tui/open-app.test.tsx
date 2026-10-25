import { cleanup, render } from 'ink-testing-library'
import { cloneElement, isValidElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppProps } from './app.js'
import type { AppDeps } from './app-context.js'
import { openApp } from './open-app.js'
import type { AppHost, StopSignal } from './open-app.js'
import type { ScreenDefinition } from './screens.js'

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

const DEPS: AppDeps = {
  version: '1.2.3',
  cwd: '/home/ana/shop',
  home: '/home/ana',
  env: {},
  scheduler: { every: () => () => {} },
}

function host(options: { screens?: readonly ScreenDefinition[] } = {}) {
  const calls: string[] = []
  const signals: ((signal?: StopSignal) => void)[] = []
  let renderedOptions: unknown
  let stdin: { write(data: string): void } | undefined
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
    press: async (key: string) => {
      stdin?.write(key)
      await settle()
    },
    renderedOptions: () => renderedOptions,
  }
}

afterEach(() => cleanup())

describe('openApp', () => {
  it('renders on the alternate screen and handles Ctrl-C itself', async () => {
    const fake = host()
    const result = openApp(DEPS, fake.appHost)
    await settle()
    await fake.press('q')
    await result
    expect(fake.renderedOptions()).toMatchObject({ alternateScreen: true, exitOnCtrlC: false })
  })

  it('unmounts and quits on q', async () => {
    const fake = host()
    const result = openApp(DEPS, fake.appHost)
    await settle()
    await fake.press('q')
    expect(await result).toEqual({ kind: 'quit' })
    expect(fake.calls).toEqual(['unmount'])
  })

  it('unmounts and stops as interrupted on Ctrl-C', async () => {
    const fake = host()
    const result = openApp(DEPS, fake.appHost)
    await settle()
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
    await settle()
    fake.signal(signal)
    fake.signal(signal)
    expect(await result).toEqual(expected)
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
