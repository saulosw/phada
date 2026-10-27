import { render } from 'ink-testing-library'
import { vi } from 'vitest'
import type { QueueView } from '../../src/app/read-queue.js'
import type { AutomationView } from '../../src/app/read-automation.js'
import type { RepositoryDetail, RepositoryList } from '../../src/app/read-repositories.js'
import { App } from '../../src/tui/app.js'
import type { AppResult } from '../../src/tui/app.js'
import type { AppDeps, Scheduler } from '../../src/tui/app-context.js'
import type { ScreenDefinition } from '../../src/tui/screens.js'
import type { SizeSource, TerminalSize } from '../../src/tui/terminal-size.js'

vi.setConfig({ testTimeout: 15_000 })

const ESC = '\u001B'

export const KEYS = {
  right: `${ESC}[C`,
  left: `${ESC}[D`,
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  pageUp: `${ESC}[5~`,
  pageDown: `${ESC}[6~`,
  home: `${ESC}[H`,
  end: `${ESC}[F`,
  tab: '\t',
  shiftTab: `${ESC}[Z`,
  enter: '\r',
  escape: ESC,
  backspace: '\u007F',
  ctrlC: '\u0003',
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

const nextTurn = () => new Promise((resolve) => setImmediate(resolve))

export async function waitFor(ready: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!ready() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  await settle()
  await nextTurn()
  await nextTurn()
}

export function shows(frame: string, ...expected: (string | RegExp)[]): boolean {
  return expected.every((text) =>
    typeof text === 'string' ? frame.includes(text) : text.test(frame),
  )
}

export async function writeKeys(stdin: { write(data: string): void }, keys: readonly string[]) {
  for (const key of keys) {
    stdin.write(key)
    if (key.endsWith(ESC)) await settle()
    await nextTurn()
    await nextTurn()
  }
}

export const NOW = new Date('2026-10-25T12:00:00.000Z')

export function minutesFrom(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString()
}

export function emptyQueue(): QueueView {
  return {
    recorded: false,
    watchConfigured: true,
    configFile: CONFIG_FILE,
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

export const CONFIG_FILE = '/home/ana/.config/phada/config.yml'

export function emptyRepositories(): RepositoryList {
  return {
    configFile: CONFIG_FILE,
    configured: false,
    configError: null,
    watching: false,
    repositories: [],
  }
}

export function emptyRepository(repo: string): RepositoryDetail {
  return {
    repo,
    configFile: CONFIG_FILE,
    origins: [],
    config: { status: 'read', settings: [], rules: [], warnings: [] },
    watch: null,
    index: { file: null, indexedSha: null, checkedAt: null },
    related: [],
    reviews: { runs: [], total: 0 },
  }
}

export function emptyAutomation(): AutomationView {
  return {
    configFile: CONFIG_FILE,
    configured: false,
    configError: null,
    watch: null,
    ci: [],
    sources: { prComments: false, enqueue: false, mcp: false, slack: null },
    hooks: null,
    when: { global: null, repos: [] },
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
    active: (ms?: number) =>
      [...ticks.values()].filter((entry) => ms === undefined || entry.ms === ms).length,
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
    start: 'home',
    cwd: '/home/ana/code/shop',
    home: '/home/ana',
    env: { TERM: 'xterm-256color' },
    scheduler,
    now: () => NOW,
    readLanguage: async () => overrides.language,
    readQueue: async () => emptyQueue(),
    readReviews: async () => ({ runs: [], total: 0 }),
    readReviewDetail: async () => undefined,
    readRepositories: async () => emptyRepositories(),
    readRepository: async (repo) => emptyRepository(repo),
    readAutomation: async () => emptyAutomation(),
    readProviderSetup: async () => ({
      choice: { provider: 'claude', model: null, origin: { kind: 'default' } },
      mcp: [],
    }),
    readProviders: async () => ({
      choice: { provider: 'claude', model: null, origin: { kind: 'default' } },
      providers: [],
    }),
    readLearnings: async () => ({ recorded: false, repos: [] }),
    readGitHub: async () => ({ source: null }),
    readUserRepositories: async () => ({ status: 'no-token', repositories: [] }),
    readLocalRules: async () => ({ lens: { kind: 'built-in' }, rules: [], warnings: [] }),
    readRepositoryRules: async () => ({ status: 'no-token' }),
    readPullRequestRules: async () => ({ status: 'no-token' }),
    handOff: async () => ({ kind: 'exited', exitCode: 0 }),
    pullModel: async () => ({ kind: 'pulled' }),
    planConfig: async () => ({
      ok: false,
      reason: 'unreadable',
      message: 'no config in this test',
    }),
    applyConfig: async () => ({ ok: true, written: true }),
    indexRepository: async () => ({ kind: 'indexed', files: 0 }),
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
  const press = (...keys: string[]) => writeKeys(app.stdin, keys)
  const type = async (text: string) => press(...[...text])
  const listening = () => app.stdin.listenerCount('readable') > 0
  const until = (ready: () => boolean) => waitFor(() => listening() && ready())
  const showing = (...expected: (string | RegExp)[]) => until(() => shows(frame(), ...expected))
  const footer = () => frameLines(frame()).at(-1) ?? ''
  return {
    app,
    frame,
    footer,
    press,
    type,
    until,
    showing,
    exits,
    resize: size.resize,
    clock,
    deps,
  }
}

export function frameLines(frame: string): string[] {
  return frame.split('\n')
}

export function visibleWidth(line: string): number {
  return [...line.replace(/\u001B\[[0-9;]*m/g, '')].length
}
