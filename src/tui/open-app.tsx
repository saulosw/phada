import { render as inkRender } from 'ink'
import type { RenderOptions } from 'ink'
import type { ReactNode } from 'react'
import { App } from './app.js'
import type { AppResult, StopSignal } from './app.js'
import type { AppDeps } from './app-context.js'
import { outputSize } from './terminal-size.js'
import type { SizeSource } from './terminal-size.js'

export type { AppResult, StopSignal } from './app.js'
export type { AppDeps, AppStart, HandOffTarget, Scheduler } from './app-context.js'

export interface RenderedApp {
  unmount(): void
  waitUntilExit(): Promise<unknown>
}

export type RenderApp = (node: ReactNode, options: RenderOptions) => RenderedApp

export interface AppHost {
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  onSignal(handler: (signal?: StopSignal) => void): void
  render?: RenderApp
  size?: SizeSource
}

export async function openApp(deps: AppDeps, host: AppHost): Promise<AppResult> {
  const render = host.render ?? inkRender
  let rendered: RenderedApp | undefined
  let outcome: AppResult | undefined
  const finish = (result: AppResult) => {
    if (outcome !== undefined) return
    outcome = result
    rendered?.unmount()
  }
  const listeners = new Set<(signal?: StopSignal) => void>()
  const signals = (listener: (signal?: StopSignal) => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  try {
    rendered = render(
      <App
        deps={deps}
        size={host.size ?? outputSize(host.stdout)}
        onExit={finish}
        signals={signals}
      />,
      {
        stdin: host.stdin,
        stdout: host.stdout,
        alternateScreen: true,
        exitOnCtrlC: false,
      },
    )
  } catch (error) {
    return { kind: 'failed', error }
  }
  if (outcome !== undefined) rendered.unmount()
  host.onSignal((signal) => {
    if (outcome === undefined) for (const listener of listeners) listener(signal)
    finish(signal === 'SIGTERM' ? { kind: 'terminated' } : { kind: 'interrupted' })
  })
  try {
    await rendered.waitUntilExit()
    return outcome ?? { kind: 'quit' }
  } catch (error) {
    return outcome ?? { kind: 'failed', error }
  }
}
