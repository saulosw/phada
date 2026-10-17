import type { Finding } from '../review/types.js'
import type { ObservedEdge, ObservedEndpoint } from '../store/observed-store.js'
import type { GraphSymbol, RepositoryGraph } from './types.js'

const SOURCE = /^(.+?)(?::(\d+)(?:-\d+)?)?$/

export interface LearnInput {
  graph: RepositoryGraph
  findings: readonly Finding[]
  verified: boolean
  readPaths: ReadonlySet<string>
  pullRequest: number
  commit: string
  known: readonly ObservedEdge[]
}

export function learnObservedEdges(input: LearnInput): ObservedEdge[] {
  if (!input.verified) return []
  const { graph } = input
  const seen = new Set(input.known.map(edgeKey))
  const learned: ObservedEdge[] = []
  for (const finding of input.findings) {
    if (finding.reason === undefined) continue
    const from = graph.symbolAt(finding.file, finding.line)
    if (from === undefined) continue
    let linked: Set<string> | undefined
    for (const source of finding.sources ?? []) {
      const match = SOURCE.exec(source.trim())
      const path = match?.[1]
      if (path === undefined || path === finding.file || !input.readPaths.has(path)) continue
      linked ??= staticallyLinked(graph, from)
      if (linked.has(path)) continue
      const line = match?.[2] === undefined ? undefined : Number(match[2])
      const target = line === undefined ? undefined : graph.symbolAt(path, line)
      const edge: ObservedEdge = {
        from: endpointOf(from),
        to: target === undefined ? { path } : endpointOf(target),
        pullRequest: input.pullRequest,
        commit: input.commit,
      }
      const key = edgeKey(edge)
      if (seen.has(key)) continue
      seen.add(key)
      learned.push(edge)
    }
  }
  return learned
}

function staticallyLinked(graph: RepositoryGraph, symbol: GraphSymbol): Set<string> {
  return new Set([
    ...graph.callers(symbol).sites.map((site) => site.path),
    ...graph
      .dependencies(symbol)
      .dependencies.flatMap((item) => (item.target === undefined ? [] : [item.target.path])),
  ])
}

function endpointOf(symbol: GraphSymbol): ObservedEndpoint {
  return {
    path: symbol.path,
    kind: symbol.kind,
    ...(symbol.owner === undefined ? {} : { owner: symbol.owner }),
    name: symbol.name,
  }
}

function edgeKey(edge: ObservedEdge): string {
  const point = (end: ObservedEndpoint) =>
    [end.path, end.kind ?? '', end.owner ?? '', end.name ?? ''].join('\0')
  return `${point(edge.from)}\u0001${point(edge.to)}`
}
