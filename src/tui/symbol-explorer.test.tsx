import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CallerList,
  DefinitionList,
  DependencyList,
  Explored,
  ExploredSymbol,
} from '../app/explore-graph.js'
import type { IndexingResult } from '../app/index-repository.js'
import type { IndexedRepository } from '../app/read-index.js'
import { frameLines, KEYS, renderApp, visibleWidth } from '../../test/support/tui.js'
import type { AppDeps } from './app-context.js'
import { SCREENS } from './screens.js'

afterEach(() => cleanup())

const GRAPH = SCREENS.filter(({ id }) => id === 'graph')
const SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'

const SHOP: IndexedRepository = {
  repo: 'acme/shop',
  index: {
    state: 'indexed',
    path: '/home/ana/.cache/phada/index/acme/shop.sqlite',
    bytes: 4096,
    snapshot: {
      sha: SHA,
      ref: 'HEAD',
      defaultBranch: true,
      indexedAt: '2026-10-25T11:00:00.000Z',
      durationMs: 1000,
    },
    summary: {
      files: {
        indexed: 10,
        ignored: 0,
        'no-grammar': 0,
        'too-large': 0,
        binary: 0,
        'parse-timeout': 0,
        'parse-failed': 0,
        missing: 0,
        symlink: 0,
        submodule: 0,
      },
      languages: { typescript: 10 },
      symbols: { function: 40 },
      imports: 1,
      exports: 1,
      calls: 1,
      references: 1,
      parseErrors: 0,
    },
    leftOut: [],
  },
}

function symbol(name: string, changes: Partial<ExploredSymbol> = {}): ExploredSymbol {
  return {
    repo: 'acme/shop',
    path: `src/${name}.ts`,
    id: name.length,
    line: 3,
    endLine: 9,
    kind: 'function',
    name,
    signature: `export function ${name}(id: string): Promise<User>`,
    exported: true,
    ...changes,
  }
}

const TOTAL = symbol('total', { path: 'src/cart/total.ts', line: 12 })
const CHECKOUT = symbol('checkout', { path: 'src/checkout.ts', line: 40 })
const PAGE = symbol('renderCart', { repo: 'acme/web', path: 'src/pages/cart.tsx', line: 8 })
const ROUND = symbol('round', { repo: 'acme/money', path: 'src/round.ts', line: 1 })

function read<T>(result: T): Explored<T> {
  return { state: 'read', repo: 'acme/shop', commit: SHA, linked: ['acme/web'], result }
}

const DEFINITIONS: Record<string, DefinitionList> = {
  total: { definitions: [TOTAL], more: 0 },
  load: {
    definitions: [
      symbol('load', { path: 'src/cart/load.ts', line: 5 }),
      symbol('load', {
        path: 'src/a/very/long/folder/name/that/goes/on/and/on/legacy-loader.ts',
        line: 77,
        kind: 'method',
        owner: 'Legacy',
        exported: false,
        signature: 'load(first: string, second: number, third: boolean, fourth: Options): void',
      }),
      symbol('load', { path: 'src/store.ts', line: 9, kind: 'variable' }),
    ],
    more: 2,
  },
}

const CALLERS: Record<string, CallerList> = {
  total: {
    sites: [
      {
        repo: 'acme/shop',
        path: 'src/checkout.ts',
        line: 44,
        in: CHECKOUT,
        kind: 'calls',
        how: 'resolved',
      },
      {
        repo: 'acme/web',
        path: 'src/pages/cart.tsx',
        line: 10,
        in: PAGE,
        kind: 'calls',
        how: 'inferred',
      },
      {
        repo: 'acme/shop',
        path: 'src/report.ts',
        line: 3,
        kind: 'related',
        how: 'observed',
        pullRequest: 12,
      },
    ],
    more: 5,
    capped: true,
  },
  checkout: {
    sites: [{ repo: 'acme/shop', path: 'src/routes.ts', line: 20, kind: 'calls', how: 'resolved' }],
    more: 0,
    capped: false,
  },
}

const DEPENDENCIES: Record<string, DependencyList> = {
  total: {
    dependencies: [
      { name: 'round', line: 14, kind: 'calls', how: 'resolved', target: ROUND },
      { name: 'format', line: 15, kind: 'calls', how: 'resolved', module: 'date-fns' },
    ],
    more: 0,
  },
  round: { dependencies: [], more: 0 },
}

interface Calls {
  searches: string[]
  callers: ExploredSymbol[]
  dependencies: ExploredSymbol[]
  indexed: string[]
}

function openExplorer(
  options: {
    deps?: Partial<AppDeps>
    language?: string
    screens?: typeof SCREENS
    callers?: (target: ExploredSymbol) => Promise<Explored<CallerList>>
  } = {},
) {
  const calls: Calls = { searches: [], callers: [], dependencies: [], indexed: [] }
  const app = renderApp({
    deps: {
      ...(options.language === undefined ? {} : { language: options.language }),
      readIndexes: async () => ({ repositories: [SHOP] }),
      searchSymbol: async (repo, name) => {
        calls.searches.push(`${repo} ${name}`)
        return read(DEFINITIONS[name] ?? { definitions: [], more: 0 })
      },
      symbolCallers: async (_repo, target) => {
        calls.callers.push(target)
        if (options.callers !== undefined) return options.callers(target)
        return read(CALLERS[target.name] ?? { sites: [], more: 0, capped: false })
      },
      symbolDependencies: async (_repo, target) => {
        calls.dependencies.push(target)
        return read(DEPENDENCIES[target.name] ?? { dependencies: [], more: 0 })
      },
      indexRepository: async (repo): Promise<IndexingResult> => {
        calls.indexed.push(repo)
        return { kind: 'indexed', files: 10 }
      },
      ...options.deps,
    },
    screens: options.screens ?? GRAPH,
    size: { columns: 80, rows: 24 },
  })
  const search = async (name: string) => {
    if (options.screens !== undefined) {
      await app.showing('Phada v1.2.3')
      await app.press(String(options.screens.findIndex(({ id }) => id === 'graph') + 1))
    }
    await app.showing('acme/shop')
    await app.press(KEYS.enter)
    await app.showing('shop.sqlite')
    await app.press('s')
    await app.showing(/(Symbol|Símbolo):/)
    await app.type(name)
    await app.press(KEYS.enter)
  }
  return { ...app, calls, search }
}

function expectFits(frame: string) {
  const lines = frameLines(frame)
  expect(lines.length).toBeLessThanOrEqual(24)
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80)
}

describe('exploring a symbol from the Graph screen', () => {
  it('searches a name typed after s and lists its definitions to pick one', async () => {
    const { calls, footer, frame, press, search, showing } = openExplorer()
    await search('load')
    await showing('3 definitions of load')
    expect(calls.searches).toEqual(['acme/shop load'])
    const text = frame()
    expect(text).toMatch(/function\s+src\/cart\/load\.ts:5\s+export function load\(id: st/)
    expect(text).toMatch(/method\s+….*legacy-loader\.ts:77\s+load\(first/)
    expect(text).toContain('+2 more')
    expect(footer()).toContain('Enter explore')
    expectFits(text)

    await press(KEYS.down, KEYS.enter)
    await showing('Callers', 'Dependencies')
    expect(frame()).toMatch(/method Legacy\.load · …?.*legacy-loader\.ts:77/)
    await press(KEYS.escape)
    await showing('3 definitions of load')
    expect(frame()).toContain('3 definitions of load')
    await press(KEYS.escape)
    await showing('Languages')
    expect(frame()).toContain('Languages')
  })

  it('offers s in the detail of a repository, and Esc leaves the field without searching', async () => {
    const { calls, footer, frame, press, showing, type, until } = openExplorer()
    await showing('acme/shop')
    expect(footer()).not.toContain('s search a symbol')
    await press(KEYS.enter)
    await showing('shop.sqlite')
    expect(footer()).toContain('s search a symbol')
    await press('s')
    await showing('Symbol:')
    expect(footer()).toContain('Enter search')
    expect(footer()).toContain('Esc cancel')
    await type('tot')
    await showing('Symbol: tot')
    expectFits(frame())
    await press(KEYS.escape)
    await until(() => !frame().includes('Symbol:'))
    expect(frame()).toContain('shop.sqlite')
    expect(calls.searches).toEqual([])
  })

  it('opens s empty for a new search after one ran', async () => {
    const { calls, frame, press, search, showing, type, until } = openExplorer()
    await search('total')
    await showing('function total · src/cart/total.ts:12')
    await press(KEYS.escape)
    await showing('shop.sqlite')
    await press('s')
    await showing('Symbol:')
    expect(frame()).not.toContain('Symbol: total')
    await type('load')
    await press(KEYS.enter)
    await until(() => calls.searches.length === 2)
    expect(calls.searches).toEqual(['acme/shop total', 'acme/shop load'])
  })

  it('opens the only definition as a tree, expanding and collapsing one level at a time', async () => {
    const { calls, footer, frame, press, search, showing, until } = openExplorer({
      screens: SCREENS,
    })
    await search('total')
    await showing('function total · src/cart/total.ts:12')
    expect(frame()).toContain('Crosses into acme/web')
    expect(frame()).toMatch(/▸ Callers/)
    expect(footer()).toContain('→ expand')

    await press(KEYS.right)
    await showing('▾ Callers', 'src/checkout.ts:44 · checkout')
    expect(calls.callers).toEqual([TOTAL])
    const text = frame()
    expect(text).toMatch(/▸ src\/checkout\.ts:44 · checkout/)
    expect(text).toMatch(/▸ acme\/web:src\/pages\/cart\.tsx:10 · renderCart · inferred/)
    expect(text).toMatch(/ {2}src\/report\.ts:3 · observed in #12/)
    expect(text).toContain('+5 more')
    expect(text).toMatch(/cut this list short/)
    expectFits(text)

    await press(KEYS.down, KEYS.enter)
    await showing('src/routes.ts:20')
    expect(calls.callers).toEqual([TOTAL, CHECKOUT])
    await press(KEYS.left)
    await showing('▸ src/checkout.ts:44')
    expect(frame()).not.toContain('src/routes.ts:20')
    await press(KEYS.left)
    await showing('▸ Callers')
    expect(frame()).not.toContain('src/checkout.ts:44')
    expect(frame()).toContain('function total')
    expect(footer()).toContain('Tab screens')

    await press(KEYS.escape)
    await showing('shop.sqlite')
    await press(KEYS.right)
    await until(() => !frame().includes('shop.sqlite'))
    expect(frame()).not.toContain('shop.sqlite')
  })

  it('follows a dependency into the repository that defines it', async () => {
    const { calls, frame, press, search, showing, until } = openExplorer()
    await search('total')
    await showing('▸ Dependencies')
    await press(KEYS.down, KEYS.enter)
    await showing('▸ round → acme/money:src/round.ts:1', 'format · date-fns')
    await press(KEYS.down, KEYS.right)
    await until(() => calls.dependencies.length === 2)
    expect(calls.dependencies).toEqual([TOTAL, ROUND])
    await showing('none')
    expect(frame()).toContain('none')
  })

  it('shows the loading node while its level is read', async () => {
    let finish: (list: Explored<CallerList>) => void = () => {}
    const { frame, press, search, showing } = openExplorer({
      callers: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    })
    await search('total')
    await showing('▸ Callers')
    await press(KEYS.enter)
    await showing('▾ Callers · loading…')
    expect(frame()).toContain('▾ Callers · loading…')
    finish(read(CALLERS.total ?? { sites: [], more: 0, capped: false }))
    await showing('src/checkout.ts:44')
    expect(frame()).not.toContain('loading…')
  })

  it('says when no definition is found and indexes the repository again with i', async () => {
    const { calls, footer, frame, press, search, showing, until } = openExplorer()
    await search('nowhere')
    await showing('No definition of nowhere')
    expect(frame()).toContain('a1b2c3d')
    expect(footer()).toContain('i index again')
    await press('i')
    await until(() => calls.indexed.length === 1 && calls.searches.length === 2)
    expect(calls.indexed).toEqual(['acme/shop'])
    expect(calls.searches).toEqual(['acme/shop nowhere', 'acme/shop nowhere'])
  })

  it('says when the repository cannot be explored and offers to index it', async () => {
    const { footer, frame, search, showing } = openExplorer({
      deps: {
        searchSymbol: async () => ({ state: 'not-indexed', why: { reason: 'no-mirror' } }),
      },
    })
    await search('total')
    await showing('no local copy')
    expect(frame()).toMatch(/acme\/shop cannot be explored \(no local copy\): press i to index it/)
    expect(footer()).toContain('i index')
  })

  it('fits 80×24 in Portuguese and Spanish', async () => {
    for (const language of ['pt', 'es']) {
      const { frame, press, search, showing } = openExplorer({ language })
      await search('load')
      await showing(/load/, /legacy-loader/)
      expectFits(frame())
      await press(KEYS.escape)
      await showing('shop.sqlite')
      await press('s')
      await showing(/Símbolo:/)
      await press(...'total', KEYS.enter)
      await showing('acme/web')
      await press(KEYS.enter)
      await showing('renderCart')
      expect(frame()).toContain('renderCart')
      expectFits(frame())
      cleanup()
    }
  })
})
