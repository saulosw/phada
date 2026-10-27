import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { IndexingOptions, IndexingResult } from '../../app/index-repository.js'
import type { ListedRepository, RepositoryOrigin } from '../../app/read-repositories.js'
import type { AppDeps } from '../app-context.js'
import {
  emptyRepositories,
  frameLines,
  KEYS,
  renderApp,
  visibleWidth,
} from '../../../test/support/tui.js'

interface IndexCall extends IndexingOptions {
  repo: string
  finish(result: IndexingResult): void
}

function listed(repo: string, origins: RepositoryOrigin[] = ['watched']): ListedRepository {
  return {
    repo,
    origins,
    publish: origins.includes('watched') ? 'pr' : null,
    index: { file: null, indexedSha: null, checkedAt: null },
    lastReview: null,
  }
}

function openGraphStep(
  options: { repositories?: ListedRepository[]; language?: string; deps?: Partial<AppDeps> } = {},
) {
  const calls: IndexCall[] = []
  const app = renderApp({
    deps: {
      start: 'setup',
      ...(options.language === undefined ? {} : { language: options.language }),
      readRepositories: async () => ({
        ...emptyRepositories(),
        repositories: options.repositories ?? [
          listed('acme/shop'),
          listed('ana/ink'),
          listed('old/blog', ['history']),
        ],
      }),
      indexRepository: (repo, indexing) =>
        new Promise<IndexingResult>((finish) => calls.push({ repo, ...indexing, finish })),
      ...options.deps,
    },
    size: { columns: 80, rows: 24 },
  })
  const seeing = async (...expected: (string | RegExp)[]) => {
    await app.showing(...expected)
    for (const text of expected) {
      if (typeof text === 'string') expect(app.frame()).toContain(text)
      else expect(app.frame()).toMatch(text)
    }
  }
  const reach = async () => {
    await app.showing('Step 1 of 7 · GitHub')
    await app.press('s', 's', 's', 's')
    await seeing('Step 5 of 7 · Graph')
  }
  const call = (index: number) => {
    const found = calls[index]
    if (found === undefined) throw new Error(`no indexing call ${index}`)
    return found
  }
  return { ...app, seeing, reach, calls, call }
}

function expectFits(frame: string) {
  const lines = frameLines(frame)
  expect(lines.length).toBeLessThanOrEqual(24)
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80)
}

afterEach(() => cleanup())

describe('the graph step', () => {
  it('lists the watched repositories and waits for Enter to index them', async () => {
    const { calls, footer, frame, reach, seeing } = openGraphStep()
    await reach()
    await seeing('acme/shop', 'ana/ink')
    expect(frame()).not.toContain('old/blog')
    expect(footer()).toContain('Enter index')
    expect(footer()).toContain('s skip')
    expect(calls).toEqual([])
    expectFits(frame())
  })

  it('indexes them one at a time with the progress of each, then goes on', async () => {
    const { call, calls, footer, frame, press, reach, seeing, until } = openGraphStep()
    await reach()
    await seeing('acme/shop')
    await press(KEYS.enter)
    await until(() => calls.length === 1)
    expect(call(0).repo).toBe('acme/shop')
    call(0).onProgress({ phase: 'fetching' })
    await seeing(/acme\/shop · fetching/)
    expect(footer()).toContain('Esc stop')
    expect(footer()).not.toContain('Esc leave')
    call(0).onProgress({ phase: 'extracting', done: 12, total: 340 })
    await seeing(/acme\/shop · 12 of 340 files/, /ana\/ink · waiting/)
    expect(calls).toHaveLength(1)
    call(0).finish({ kind: 'indexed', files: 1200 })
    await until(() => calls.length === 2)
    expect(call(1).repo).toBe('ana/ink')
    await seeing(/acme\/shop · 1,200 files indexed/)
    call(1).finish({ kind: 'indexed', files: 8 })
    await seeing(/ana\/ink · 8 files indexed/)
    expect(footer()).toContain('Enter continue')
    expectFits(frame())
    await press(KEYS.enter)
    await seeing('Step 6 of 7')
  })

  it('offers no skip while indexing, so the summary keeps what was indexed', async () => {
    const { call, calls, footer, press, reach, seeing, until } = openGraphStep()
    await reach()
    await seeing('acme/shop')
    await press(KEYS.enter)
    await until(() => calls.length === 1)
    call(0).onProgress({ phase: 'extracting', done: 2, total: 40 })
    await seeing(/acme\/shop · 2 of 40 files/)
    expect(footer()).not.toContain('s skip')
    await press('s')
    call(0).finish({ kind: 'indexed', files: 40 })
    await seeing(/acme\/shop · 40 files indexed/, 'Step 5 of 7')
    expect(call(0).signal.aborted).toBe(false)
  })

  it('stops on Esc: the current one is cancelled, the rest is left for later', async () => {
    const { call, calls, frame, press, reach, seeing, until } = openGraphStep({
      repositories: [listed('acme/shop'), listed('ana/ink'), listed('ana/web')],
    })
    await reach()
    await seeing('acme/shop')
    await press(KEYS.enter)
    await until(() => calls.length === 1)
    call(0).finish({ kind: 'indexed', files: 3 })
    await until(() => calls.length === 2)
    call(1).onProgress({ phase: 'extracting', done: 40, total: 900 })
    await seeing(/ana\/ink · 40 of 900 files/)
    await press(KEYS.escape)
    await until(() => call(1).signal.aborted)
    await seeing(/ana\/ink · stopping/)
    call(1).finish({ kind: 'cancelled', extracted: 41, total: 900 })
    await seeing(/ana\/ink · stopped at 41 of 900 files/, /ana\/web · not started/)
    expect(frame()).toContain('acme/shop · 3 files indexed')
    expect(frame()).toContain('phada watch indexes what was left when it is idle')
    expect(calls).toHaveLength(2)
    expectFits(frame())
  })

  it('shows a failure in one line and goes on with the next', async () => {
    const { call, calls, frame, reach, press, seeing, until } = openGraphStep()
    await reach()
    await seeing('acme/shop')
    await press(KEYS.enter)
    await until(() => calls.length === 1)
    call(0).finish({
      kind: 'failed',
      message: `Could not fetch HEAD from acme/shop: ${'remote: Repository not found. '.repeat(4)}`,
    })
    await until(() => calls.length === 2)
    await seeing(/✕ acme\/shop · Could not fetch HEAD from acme\/shop/)
    call(1).finish({ kind: 'no-token' })
    await seeing(/ana\/ink · no GitHub token/)
    expectFits(frame())
  })

  it('says when no repository is watched, and Enter goes on', async () => {
    const { calls, footer, press, reach, seeing } = openGraphStep({
      repositories: [listed('old/blog', ['history'])],
    })
    await reach()
    await seeing('No repository is watched yet')
    expect(footer()).toContain('Enter continue')
    await press(KEYS.enter)
    await seeing('Step 6 of 7')
    expect(calls).toEqual([])
  })

  it('cancels the indexing when the setup is left for another screen', async () => {
    const { call, calls, frame, press, reach, seeing, type, until } = openGraphStep()
    await reach()
    await seeing('acme/shop')
    await press(KEYS.enter)
    await until(() => calls.length === 1)
    await press('/')
    await type('queue')
    await press(KEYS.enter)
    await seeing('No watch has run here yet.')
    expect(frame()).not.toContain('Step 5 of 7')
    await until(() => call(0).signal.aborted)
    call(0).finish({ kind: 'cancelled', extracted: 0, total: 10 })
    expect(calls).toHaveLength(1)
  })

  it('speaks pt', async () => {
    const { call, calls, press, seeing, until } = openGraphStep({ language: 'pt' })
    await seeing(/ 1 de 7 · GitHub/)
    await press('s', 's', 's', 's')
    await seeing('Passo 5 de 7 · Grafo', 'acme/shop')
    await press(KEYS.enter)
    await until(() => calls.length === 1)
    call(0).onProgress({ phase: 'extracting', done: 2, total: 5 })
    await seeing(/acme\/shop · 2 de 5 arquivos/)
  })
})
