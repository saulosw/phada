import type { SymbolKind } from '../repo-map/types.js'
import type { IndexReader } from '../store/index-reader.js'
import type { ObservedEdge } from '../store/observed-store.js'

export type EdgeHow = 'resolved' | 'inferred' | 'observed'
export type EdgeKind = 'calls' | 'uses' | 'inherits' | 'related'

export interface GraphSymbol {
  path: string
  id: number
  kind: SymbolKind
  name: string
  owner?: string
  startLine: number
  endLine: number
  exported: boolean
  signature: string
}

export interface Site {
  path: string
  line: number
  target: GraphSymbol
  in?: GraphSymbol
  kind: EdgeKind
  how: EdgeHow
  pullRequest?: number
}

export interface Dependency {
  name: string
  line: number
  kind: EdgeKind
  how: EdgeHow
  target?: GraphSymbol
  module?: string
  pullRequest?: number
}

export interface SimilarSymbol {
  symbol: GraphSymbol
  score: number
  shared: string[]
}

export interface SymbolTarget {
  name: string
  path?: string
}

export interface Targets {
  symbols: GraphSymbol[]
  others: number
}

export interface CallersResult extends Targets {
  sites: Site[]
  capped: boolean
}

export interface DependenciesResult extends Targets {
  dependencies: Dependency[]
}

export interface SimilarResult extends Targets {
  similar: SimilarSymbol[]
}

export interface RepositoryGraph {
  readonly commit: string
  findSymbol(name: string, kind?: SymbolKind): GraphSymbol[]
  targets(target: SymbolTarget | GraphSymbol): Targets
  callers(target: SymbolTarget | GraphSymbol): CallersResult
  dependencies(target: SymbolTarget | GraphSymbol): DependenciesResult
  similar(target: SymbolTarget | GraphSymbol): SimilarResult
  symbolAt(path: string, line: number): GraphSymbol | undefined
  lineText(path: string, line: number): Promise<string | undefined>
  staleObserved(): number[]
}

export interface OpenGraphInput {
  reader: IndexReader
  readText: (path: string) => Promise<string>
  observed?: readonly ObservedEdge[]
}
