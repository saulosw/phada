import { describe, expect, it } from 'vitest'
import { indexFixture } from '../../test/support/index-fixture.js'
import { openRepositoryGraph } from '../graph/repository-graph.js'
import type { Checkout } from '../repository/checkout.js'
import { createInvestigation } from './create-investigation.js'

function checkout(onClose: () => void = () => {}): Checkout {
  return {
    commit: 'abc',
    readText: async () => '',
    grep: async () => [],
    listDir: async () => [],
    history: async () => ({ commits: [], truncated: false }),
    close: async () => onClose(),
  }
}

describe('createInvestigation', () => {
  it('offers the reading tools and history without a graph', () => {
    const investigation = createInvestigation(checkout())

    expect(investigation.tools('review').definitions.map(({ name }) => name)).toEqual([
      'read_file',
      'grep',
      'list',
      'history',
    ])
  })

  it('adds the graph tools when there is a graph, with one log for both passes', async () => {
    const { reader, readText } = await indexFixture({ 'a.ts': 'export function f() {}\n' })
    const graph = await openRepositoryGraph({ reader, readText })
    const investigation = createInvestigation(checkout(), { graph })

    const review = investigation.tools('review')
    await review.call('find_symbol', { name: 'f' })
    await investigation.tools('verify').call('find_symbol', { name: 'f' })

    expect(review.definitions.map(({ name }) => name)).toEqual([
      'read_file',
      'grep',
      'list',
      'history',
      'find_symbol',
      'callers',
      'dependencies',
      'similar',
    ])
    expect(investigation.log.records.map((record) => record.pass)).toEqual(['review', 'verify'])
  })

  it('closes the checkout', async () => {
    let closed = false
    await createInvestigation(checkout(() => (closed = true))).close()

    expect(closed).toBe(true)
  })
})

describe('createInvestigation with related repositories', () => {
  it('offers repo on the reading and graph tools, never on history, and closes every checkout', async () => {
    const closed: string[] = []
    const investigation = createInvestigation(
      checkout(() => closed.push('reviewed')),
      {
        related: [{ repo: 'acme/web', checkout: checkout(() => closed.push('acme/web')) }],
      },
    )

    const definitions = investigation.tools('review').definitions
    const withRepo = definitions
      .filter((definition) => JSON.stringify(definition.inputSchema).includes('"repo"'))
      .map(({ name }) => name)
    await investigation.close()

    expect(withRepo).toEqual(['read_file', 'grep', 'list'])
    expect(closed).toEqual(['reviewed', 'acme/web'])
  })
})
