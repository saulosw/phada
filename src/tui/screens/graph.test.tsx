import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { IndexingOptions, IndexingResult } from '../../app/index-repository.js'
import type { IndexedRepository, RepositoryIndexes } from '../../app/read-index.js'
import {
  frameLines,
  KEYS,
  minutesFrom,
  NOW,
  renderApp,
  visibleWidth,
} from '../../../test/support/tui.js'
import type { AppDeps } from '../app-context.js'
import { SCREENS } from '../screens.js'
import { GraphScreen } from './graph.js'

afterEach(() => cleanup())

const GRAPH = SCREENS.filter(({ id }) => id === 'graph')

const SHA = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b'

function indexed(repo: string, changes: { sha?: string; files?: number } = {}): IndexedRepository {
  const [owner = '', name = ''] = repo.split('/')
  return {
    repo,
    index: {
      state: 'indexed',
      path: `/home/ana/.cache/phada/index/${owner}/${name}.sqlite`,
      bytes: 12_900_000,
      snapshot: {
        sha: changes.sha ?? SHA,
        ref: 'HEAD',
        defaultBranch: true,
        indexedAt: minutesFrom(NOW, -120),
        durationMs: 5300,
      },
      summary: {
        files: {
          indexed: changes.files ?? 1240,
          ignored: 2,
          'no-grammar': 5,
          'too-large': 1,
          binary: 0,
          'parse-timeout': 0,
          'parse-failed': 0,
          missing: 0,
          symlink: 0,
          submodule: 0,
        },
        languages: { python: 240, typescript: 1000 },
        symbols: { function: 8000, class: 310, method: 1 },
        imports: 900,
        exports: 600,
        calls: 4000,
        references: 2100,
        parseErrors: 1,
      },
      leftOut: [
        {
          reason: 'no-grammar',
          files: 5,
          extensions: [
            { extension: '.md', files: 2 },
            { extension: '.json', files: 1 },
            { extension: '.yml', files: 1 },
            { extension: '', files: 1 },
          ],
        },
        { reason: 'ignored', files: 2, extensions: [{ extension: '.lock', files: 2 }] },
        { reason: 'too-large', files: 1, extensions: [{ extension: '.js', files: 1 }] },
      ],
    },
  }
}

const MISSING: IndexedRepository = {
  repo: 'acme/web',
  index: { state: 'missing', path: '/home/ana/.cache/phada/index/acme/web.sqlite' },
}

const OLD: IndexedRepository = {
  repo: 'acme/old',
  index: {
    state: 'other-version',
    path: '/home/ana/.cache/phada/index/acme/old.sqlite',
    bytes: 2048,
    found: { schemaVersion: '3', phadaVersion: '0.9.0' },
    expected: { schemaVersion: '3', phadaVersion: '1.2.3' },
  },
}

const BROKEN: IndexedRepository = {
  repo: 'acme/broken',
  index: {
    state: 'unreadable',
    path: '/home/ana/.cache/phada/index/acme/broken.sqlite',
    error: 'Cannot read the index at /x: it is not a Phada index',
  },
}

const EMPTY: IndexedRepository = {
  repo: 'acme/empty',
  index: { state: 'empty', path: '/home/ana/.cache/phada/index/acme/empty.sqlite', bytes: 4096 },
}

interface IndexCall extends IndexingOptions {
  repo: string
  finish(result: IndexingResult): void
}

function openGraph(
  options: {
    indexes?: () => RepositoryIndexes
    language?: string
    deps?: Partial<AppDeps>
    size?: { columns: number; rows: number }
    screens?: typeof SCREENS
  } = {},
) {
  const calls: IndexCall[] = []
  let reads = 0
  const app = renderApp({
    deps: {
      ...(options.language === undefined ? {} : { language: options.language }),
      readIndexes: async () => {
        reads += 1
        return options.indexes?.() ?? { repositories: [indexed('acme/shop'), MISSING, OLD] }
      },
      indexRepository: (repo, indexing) =>
        new Promise<IndexingResult>((finish) => calls.push({ repo, ...indexing, finish })),
      ...options.deps,
    },
    screens: options.screens ?? GRAPH,
    size: options.size ?? { columns: 80, rows: 24 },
  })
  const call = (index: number) => {
    const found = calls[index]
    if (found === undefined) throw new Error(`no indexing call ${index}`)
    return found
  }
  return { ...app, calls, call, reads: () => reads }
}

function expectFits(frame: string, columns = 80, rows = 24) {
  const lines = frameLines(frame)
  expect(lines.length).toBeLessThanOrEqual(rows)
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(columns)
}

describe('the Graph screen', () => {
  it('is registered between Provider and Learnings', () => {
    const ids = SCREENS.map(({ id }) => id)
    expect(ids.indexOf('graph')).toBe(ids.indexOf('provider') + 1)
    expect(ids.indexOf('learnings')).toBe(ids.indexOf('graph') + 1)
    expect(SCREENS.find(({ id }) => id === 'graph')?.Screen).toBe(GraphScreen)
  })

  it('lists each repository with its index state, commit, files, symbols and size', async () => {
    const { footer, frame, showing } = openGraph()
    await showing('acme/shop', 'acme/web', 'acme/old')
    expect(frame()).toContain('3 repositories · 1 indexed')
    expect(frame()).toMatch(/acme\/shop\s+indexed\s+1a2b3c4\s+1,240\s+8,311\s+12\.3 MB/)
    expect(frame()).toMatch(/acme\/web\s+no index/)
    expect(frame()).toMatch(/acme\/old\s+other version\s+–\s+–\s+–\s+2\.0 KB/)
    expect(footer()).toContain('Enter open')
    expect(footer()).toContain('i index again')
    expectFits(frame())
  })

  it('says how to get repositories when there are none', async () => {
    const { frame, showing } = openGraph({ indexes: () => ({ repositories: [] }) })
    await showing('No repositories yet')
    expectFits(frame())
  })

  it('opens a repository with its index summary and goes back with Esc', async () => {
    const { footer, frame, press, showing } = openGraph()
    await showing('acme/shop')
    await press(KEYS.enter)
    await showing('Languages')
    const text = frame()
    expect(text).toMatch(/Indexed\s+2h ago \(/)
    expect(text).toMatch(/Commit\s+1a2b3c4 · default branch/)
    expect(text).toMatch(/Took\s+5s/)
    expect(text).toMatch(/Files\s+1,240 indexed · 8 left out/)
    expect(text).toMatch(/Languages\s+TypeScript 1,000 · Python 240/)
    expect(text).toMatch(/Symbols\s+8,000 functions · 310 classes · 1 method/)
    expect(text).toMatch(/Links\s+900 imports · 600 exports · 4,000 calls · 2,100 uses · 1 parse/)
    expect(text).toMatch(
      /Left out\s+5 without grammar \(\.md 2, \.json 1, \.yml 1, other 1\) · 2 ignored/,
    )
    expect(text).toContain('~/.cache/phada/index/acme/shop.sqlite · 12.3 MB')
    expect(footer()).toContain('Esc back')
    expectFits(text)
    await press(KEYS.escape)
    await showing('3 repositories')
  })

  it.each([
    [MISSING, 'This repository has no index yet: press i to index it.', 'i index'],
    [
      OLD,
      'Made by another version of Phada (0.9.0, schema 3); this one is 1.2.3, schema 3.',
      'i index again',
    ],
    [BROKEN, 'it is not a Phada index', 'i index again'],
    [EMPTY, 'The index holds no commit yet', 'i index'],
  ])('shows an index that is $index.state and offers to index it', async (entry, text, key) => {
    const { footer, frame, press, showing } = openGraph({
      indexes: () => ({ repositories: [entry] }),
    })
    await showing(entry.repo)
    expect(footer()).toContain(key)
    await press(KEYS.enter)
    await showing(text)
    expect(footer()).toContain(key)
    expectFits(frame())
  })

  it('indexes the selected repository with its progress, then reads the indexes again', async () => {
    const { call, calls, footer, frame, press, reads, showing, until } = openGraph()
    await showing('acme/web')
    await press(KEYS.down, 'i')
    await until(() => calls.length === 1)
    expect(call(0).repo).toBe('acme/web')
    call(0).onProgress({ phase: 'fetching' })
    await showing(/acme\/web · fetching/)
    expect(footer()).toContain('Esc stop indexing')
    call(0).onProgress({ phase: 'extracting', done: 12, total: 340 })
    await showing(/acme\/web · 12 of 340 files/)
    await press('i')
    expect(calls).toHaveLength(1)
    expectFits(frame())
    const before = reads()
    call(0).finish({ kind: 'indexed', files: 340 })
    await showing(/acme\/web · 340 files indexed/)
    await until(() => reads() > before)
    expect(footer()).not.toContain('Esc stop indexing')
  })

  it('stops indexing on Esc and stays on the list', async () => {
    const { call, calls, frame, press, showing, until } = openGraph()
    await showing('acme/shop')
    await press('i')
    await until(() => calls.length === 1)
    await press(KEYS.escape)
    await until(() => call(0).signal.aborted)
    await showing(/acme\/shop · stopping…/)
    call(0).finish({ kind: 'cancelled', extracted: 3, total: 340 })
    await showing(/acme\/shop · stopped at 3 of 340 files/)
    expect(frame()).toContain('3 repositories')
  })

  it('indexes the open repository and shows its new commit', async () => {
    let sha = SHA
    const { call, calls, press, showing, until } = openGraph({
      indexes: () => ({ repositories: [indexed('acme/shop', { sha })] }),
    })
    await showing('acme/shop')
    await press(KEYS.enter)
    await showing('Languages')
    await press('i')
    await until(() => calls.length === 1)
    expect(call(0).repo).toBe('acme/shop')
    await press(KEYS.escape)
    await until(() => call(0).signal.aborted)
    sha = 'f'.repeat(40)
    call(0).finish({ kind: 'indexed', files: 1240 })
    await showing(/Commit\s+fffffff/)
  })

  it('aborts the indexing when the screen goes away', async () => {
    const screens = SCREENS.filter(({ id }) => id === 'graph' || id === 'learnings')
    const { call, calls, press, showing, until } = openGraph({ screens })
    await showing('acme/shop')
    await press('i')
    await until(() => calls.length === 1)
    await press('2')
    await until(() => call(0).signal.aborted)
    expect(call(0).signal.aborted).toBe(true)
  })

  it('fits 80×24 in Portuguese and Spanish', async () => {
    for (const language of ['pt', 'es']) {
      const { frame, press, showing } = openGraph({ language })
      await showing('acme/shop', /1a2b3c4/)
      expectFits(frame())
      await press(KEYS.enter)
      await showing('TypeScript')
      expectFits(frame())
      cleanup()
    }
  })

  it('is where /index in the palette goes', async () => {
    const { press, showing, type } = openGraph({ screens: SCREENS })
    await showing('Phada v1.2.3')
    await press('/')
    await type('index')
    await showing('Index a repository')
    await press(KEYS.enter)
    await showing('3 repositories · 1 indexed')
  })
})
