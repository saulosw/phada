import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { indexFixture } from '../../test/support/index-fixture.js'
import type { ObservedEdge } from '../store/observed-store.js'
import { learnObservedEdges } from './observe.js'
import { openRepositoryGraph } from './repository-graph.js'

const FILES = {
  'src/users.ts': `export function getUser(id: string) {
  return id
}
`,
  'src/routes.ts': `export const routes = {
  user: 'getUser',
}
export function dispatch(name: string) {
  return name
}
`,
  'src/api.ts': `import { getUser } from './users'
export function handle(id: string) {
  return getUser(id)
}
`,
}

async function setup(observed: readonly ObservedEdge[] = []) {
  const { reader, readText } = await indexFixture(FILES)
  return openRepositoryGraph({ reader, readText, observed })
}

const confirmed = (sources: string[]) =>
  findingFixture({
    file: 'src/users.ts',
    line: 2,
    sources,
    reason: 'The router still calls it by name',
  })

describe('learnObservedEdges', () => {
  it('ties the changed symbol to the symbol a confirmed finding cites from a file the AI read', async () => {
    const graph = await setup()

    const edges = learnObservedEdges({
      graph,
      findings: [confirmed(['src/routes.ts:4-6', 'src/users.ts:2'])],
      verified: true,
      readPaths: new Set(['src/routes.ts']),
      pullRequest: 12,
      commit: graph.commit,
      known: [],
    })

    expect(edges).toEqual([
      {
        from: { path: 'src/users.ts', kind: 'function', name: 'getUser' },
        to: { path: 'src/routes.ts', kind: 'function', name: 'dispatch' },
        pullRequest: 12,
        commit: graph.commit,
      },
    ])
  })

  it('ties to the whole file when the source has no lines', async () => {
    const graph = await setup()

    const [edge] = learnObservedEdges({
      graph,
      findings: [confirmed(['src/routes.ts'])],
      verified: true,
      readPaths: new Set(['src/routes.ts']),
      pullRequest: 12,
      commit: graph.commit,
      known: [],
    })

    expect(edge?.to).toEqual({ path: 'src/routes.ts' })
  })

  it('learns nothing from unverified findings, findings without a verdict or sources the AI never read', async () => {
    const graph = await setup()
    const base = { graph, pullRequest: 12, commit: graph.commit, known: [] }

    expect(
      learnObservedEdges({
        ...base,
        findings: [confirmed(['src/routes.ts'])],
        verified: false,
        readPaths: new Set(['src/routes.ts']),
      }),
    ).toEqual([])
    expect(
      learnObservedEdges({
        ...base,
        findings: [findingFixture({ file: 'src/users.ts', line: 2, sources: ['src/routes.ts'] })],
        verified: true,
        readPaths: new Set(['src/routes.ts']),
      }),
    ).toEqual([])
    expect(
      learnObservedEdges({
        ...base,
        findings: [confirmed(['src/routes.ts'])],
        verified: true,
        readPaths: new Set(),
      }),
    ).toEqual([])
  })

  it('skips relations the static graph already has and edges it already knows', async () => {
    const graph = await setup()
    const known: ObservedEdge = {
      from: { path: 'src/users.ts', kind: 'function', name: 'getUser' },
      to: { path: 'src/routes.ts' },
      pullRequest: 3,
      commit: graph.commit,
    }

    expect(
      learnObservedEdges({
        graph,
        findings: [confirmed(['src/api.ts:3', 'src/routes.ts'])],
        verified: true,
        readPaths: new Set(['src/api.ts', 'src/routes.ts']),
        pullRequest: 12,
        commit: graph.commit,
        known: [known],
      }),
    ).toEqual([])
  })
})

describe('observed edges in the graph', () => {
  const edge: ObservedEdge = {
    id: 7,
    from: { path: 'src/users.ts', kind: 'function', name: 'getUser' },
    to: { path: 'src/routes.ts', kind: 'function', name: 'dispatch' },
    pullRequest: 12,
    commit: 'c'.repeat(40),
  }

  it('shows a valid edge from both ends, marked observed, after the static ones', async () => {
    const graph = await setup([edge])

    const fromUsers = graph.callers({ name: 'getUser' }).sites
    const fromRoutes = graph.callers({ name: 'dispatch' }).sites

    expect(
      fromUsers.map(
        (site) => `${site.path}:${site.line} ${site.kind} ${site.how} #${site.pullRequest}`,
      ),
    ).toEqual(['src/api.ts:3 calls resolved #undefined', 'src/routes.ts:4 related observed #12'])
    expect(
      fromRoutes.map((site) => `${site.path}:${site.line} ${site.in?.name} ${site.how}`),
    ).toEqual(['src/users.ts:1 getUser observed'])
    expect(graph.dependencies({ name: 'getUser' }).dependencies).toEqual([
      expect.objectContaining({
        name: 'dispatch',
        kind: 'related',
        how: 'observed',
        pullRequest: 12,
      }),
    ])
    expect(graph.staleObserved()).toEqual([])
  })

  it('drops an edge whose end no longer exists', async () => {
    const gone: ObservedEdge = {
      ...edge,
      id: 8,
      to: { path: 'src/routes.ts', kind: 'function', name: 'removed' },
    }
    const graph = await setup([gone, { ...edge, id: 9, to: { path: 'src/deleted.ts' } }])

    expect(graph.callers({ name: 'getUser' }).sites.map((site) => site.how)).toEqual(['resolved'])
    expect(graph.staleObserved()).toEqual([8, 9])
  })
})
