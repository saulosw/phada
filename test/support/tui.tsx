import { render } from 'ink-testing-library'
import type { QueueView } from '../../src/app/read-queue.js'
import { App } from '../../src/tui/app.js'
import type { AppResult } from '../../src/tui/app.js'
import type { AppDeps, Scheduler } from '../../src/tui/app-context.js'
import type { ScreenDefinition } from '../../src/tui/screens.js'
import type { SizeSource, TerminalSize } from '../../src/tui/terminal-size.js'

const ESC = '\u001B'

export const KEYS = {
  right: `${ESC}[C`,
  left: `${ESC}[D`,
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  pageUp: `${ESC}[5~`,
  pageDown: `${ESC}[6~`,
  tab: '\t',
  shiftTab: `${ESC}[Z`,
  enter: '\r',
  escape: ESC,
  backspace: '\u007F',
  ctrlC: '\u0003',
}

export const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

export const NOW = new Date('2026-10-25T12:00:00.000Z')

export function minutesFrom(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString()
}

export function emptyQueue(): QueueView {
  return {
    recorded: false,
    holder: null,
    pause: null,
    hourly: null,
    repos: [],
    lastCycleAt: null,
    nextCycle: null,
    queue: [],
    running: [],
    skippedForCi: [],
    failed: [],
    lastRuns: [],
  }
}

export function fakeScheduler() {
  const ticks = new Map<number, { ms: number; tick: () => void }>()
  let next = 0
  const scheduler: Scheduler = {
    every: (ms, tick) => {
      const id = next++
      ticks.set(id, { ms, tick })
      return () => ticks.delete(id)
    },
  }
  return {
    scheduler,
    advance: (ms: number) => {
      for (const { ms: every, tick } of [...ticks.values()]) if (every <= ms) tick()
    },
    active: () => ticks.size,
  }
}

export function fakeSize(initial: TerminalSize) {
  let size = initial
  const listeners = new Set<() => void>()
  const source: SizeSource = {
    current: () => size,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    source,
    resize: (next: TerminalSize) => {
      size = next
      for (const listener of listeners) listener()
    },
  }
}

export function fakeAppDeps(scheduler: Scheduler, overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    version: '1.2.3',
    cwd: '/home/ana/code/shop',
    home: '/home/ana',
    env: { TERM: 'xterm-256color' },
    scheduler,
    now: () => NOW,
    readQueue: async () => emptyQueue(),
    readReviews: async () => ({ runs: [], total: 0 }),
    readReviewDetail: async () => undefined,
    ...overrides,
  }
}

export function renderApp(
  options: {
    deps?: Partial<AppDeps>
    size?: TerminalSize
    screens?: readonly ScreenDefinition[]
  } = {},
) {
  const size = fakeSize(options.size ?? { columns: 100, rows: 30 })
  const clock = fakeScheduler()
  const exits: AppResult[] = []
  const deps = fakeAppDeps(clock.scheduler, options.deps)
  const app = render(
    <App
      deps={deps}
      size={size.source}
      onExit={(result) => exits.push(result)}
      {...(options.screens === undefined ? {} : { screens: options.screens })}
    />,
  )
  const frame = () => app.lastFrame() ?? ''
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      app.stdin.write(key)
      await settle()
    }
  }
  const type = async (text: string) => press(...[...text])
  return { app, frame, press, type, exits, resize: size.resize, clock, deps }
}

export function frameLines(frame: string): string[] {
  return frame.split('\n')
}

export function visibleWidth(line: string): number {
  return [...line.replace(/\u001B\[[0-9;]*m/g, '')].length
}
