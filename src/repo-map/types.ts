export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'struct'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'parameter'

export interface ExtractedSymbol {
  key: number
  kind: SymbolKind
  name: string
  parent?: number
  container?: string
  startLine: number
  endLine: number
  exported: boolean
  signature: string
}

export type ImportKind = 'named' | 'default' | 'namespace' | 'side-effect' | 'require'

export interface ExtractedImport {
  module: string
  name?: string
  alias?: string
  kind: ImportKind
  line: number
}

export interface ExtractedExport {
  name: string
  local?: string
  module?: string
  line: number
}

export interface ExtractedCall {
  caller?: number
  name: string
  qualifier?: string
  line: number
  constructs: boolean
}

export type HeritageRelation = 'extends' | 'implements' | 'embeds'

export interface ExtractedHeritage {
  symbol: number
  name: string
  relation: HeritageRelation
}

export interface FileMap {
  symbols: ExtractedSymbol[]
  imports: ExtractedImport[]
  exports: ExtractedExport[]
  calls: ExtractedCall[]
  heritage: ExtractedHeritage[]
  parseErrors: number
}
