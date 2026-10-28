import { describe, expect, it } from 'vitest'
import type { ExploredSymbol, GraphExplorer, GraphOpening } from '../app/explore-graph.js'
import { appGraph } from './app-graph.js'

const SYMBOL: ExploredSymbol = {
  repo: 'acme/shop',
  path: 'src/cart.ts',
  id: 1,
  line: 3,
  endLine: 9,
  kind: 'function',
  name: 'total',
  signature: 'function total()',
  exported: true,
}

function fakeExplorers(commits: Record<string, string | undefined>) {
  const opened: string[] = []
  const closed: string[] = []
  const open = async (repo: string): Promise<GraphOpening> => {
    const commit = commits[repo]
    if (commit === undefined) return { state: 'not-indexed', why: { reason: 'no-index' } }
    opened.push(`${repo}@${commit}`)
    const explorer: GraphExplorer = {
      repo,
      commit,
      linked: ['acme/ui'],
      search: () => ({ definitions: [SYMBOL], more: 0 }),
      callers: () => ({ sites: [], more: 0, capped: true }),
      dependencies: () => ({ dependencies: [], more: 2 }),
      close: () => closed.push(`${repo}@${commit}`),
    }
    return { state: 'open', explorer }
  }
  const graph = appGraph({ open, commitOf: async (repo) => commits[repo] })
  return { graph, opened, closed }
}

describe('appGraph', () => {
  it('opens the graph of a repository once for its searches and expansions', async () => {
    const { graph, opened } = fakeExplorers({ 'acme/shop': 'a1' })

    expect(await graph.searchSymbol('acme/shop', 'total')).toEqual({
      state: 'read',
      repo: 'acme/shop',
      commit: 'a1',
      linked: ['acme/ui'],
      result: { definitions: [SYMBOL], more: 0 },
    })
    expect(await graph.symbolCallers('acme/shop', SYMBOL)).toMatchObject({
      result: { capped: true },
    })
    expect(await graph.symbolDependencies('acme/shop', SYMBOL)).toMatchObject({
      result: { more: 2 },
    })
    await graph.searchSymbol('acme/shop', 'other')

    expect(opened).toEqual(['acme/shop@a1'])
  })

  it('keeps one repository open at a time, closing the previous one', async () => {
    const { graph, opened, closed } = fakeExplorers({ 'acme/shop': 'a1', 'acme/ui': 'b1' })

    await graph.searchSymbol('acme/shop', 'total')
    await graph.searchSymbol('acme/ui', 'Button')

    expect(opened).toEqual(['acme/shop@a1', 'acme/ui@b1'])
    expect(closed).toEqual(['acme/shop@a1'])
  })

  it('opens the graph again on a search once the index has a new commit', async () => {
    const commits: Record<string, string | undefined> = { 'acme/shop': 'a1' }
    const { graph, opened, closed } = fakeExplorers(commits)

    await graph.searchSymbol('acme/shop', 'total')
    commits['acme/shop'] = 'a2'
    await graph.symbolCallers('acme/shop', SYMBOL)
    expect(opened).toEqual(['acme/shop@a1'])
    await graph.searchSymbol('acme/shop', 'total')

    expect(opened).toEqual(['acme/shop@a1', 'acme/shop@a2'])
    expect(closed).toEqual(['acme/shop@a1'])
  })

  it('says a repository is not indexed and opens it once it is', async () => {
    const commits: Record<string, string | undefined> = {}
    const { graph, opened } = fakeExplorers(commits)

    expect(await graph.searchSymbol('acme/shop', 'total')).toEqual({
      state: 'not-indexed',
      why: { reason: 'no-index' },
    })
    commits['acme/shop'] = 'a1'

    expect(await graph.searchSymbol('acme/shop', 'total')).toMatchObject({ state: 'read' })
    expect(opened).toEqual(['acme/shop@a1'])
  })

  it('closes the open graph when the app ends and opens no other', async () => {
    const { graph, closed } = fakeExplorers({ 'acme/shop': 'a1', 'acme/ui': 'b1' })
    await graph.searchSymbol('acme/shop', 'total')

    graph.close()
    expect(closed).toEqual(['acme/shop@a1'])

    await expect(graph.searchSymbol('acme/ui', 'Button')).rejects.toThrow(/closed/)
    expect(closed).toEqual(['acme/shop@a1'])
  })

  it('closes a graph whose opening ends after the app closed', async () => {
    const { graph, closed } = fakeExplorers({ 'acme/shop': 'a1' })
    const search = graph.searchSymbol('acme/shop', 'total')
    graph.close()

    await expect(search).rejects.toThrow(/closed/)
    expect(closed).toEqual(['acme/shop@a1'])
  })
})
