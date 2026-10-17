import type { Language } from '../repo-map/languages.js'
import type { SymbolKind } from '../repo-map/types.js'
import type { IndexReader } from '../store/index-reader.js'
import type { ObservedEdge } from '../store/observed-store.js'

export type EdgeHow = 'resolved' | 'inferred' | 'observed'
export type EdgeKind = 'calls' | 'uses' | 'inherits' | 'related'

export interface GraphSymbol {
  repo?: string
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
  repo?: string
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
  imported?: string
  member?: string
  pullRequest?: number
}

export interface ExternalSite {
  path: string
  line: number
  name: string
  in?: GraphSymbol
  kind: 'calls' | 'uses'
  module?: string
  imported?: string
  member?: string
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
  lineText(path: string, line: number, repo?: string): Promise<string | undefined>
  exported(specifier: string, name: string, language: Language): GraphSymbol[]
  members(owner: GraphSymbol, name: string): GraphSymbol[]
  exportedMethods(name: string): GraphSymbol[]
  externalSites(name: string): ExternalSite[]
  importsModule(path: string, accepts: (module: string) => boolean): boolean
  languageOf(path: string): Language | undefined
}

export interface OpenGraphInput {
  reader: IndexReader
  readText: (path: string) => Promise<string>
  observed?: readonly ObservedEdge[]
  now?: () => number
}
