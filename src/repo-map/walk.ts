import type { Node } from 'web-tree-sitter'
import type { FileMap, HeritageRelation, ImportKind, SymbolKind } from './types.js'

export const SIGNATURE_MAX_CHARS = 200
export const QUALIFIER_MAX_CHARS = 80

const OWNER_KINDS: ReadonlySet<SymbolKind> = new Set([
  'function',
  'method',
  'class',
  'struct',
  'interface',
])

export interface SymbolOptions {
  exported?: boolean
  parent?: number
  container?: string
  body?: Node | null
}

export class Collector {
  readonly map: FileMap = {
    symbols: [],
    imports: [],
    exports: [],
    calls: [],
    heritage: [],
    parseErrors: 0,
  }
  readonly #owners: number[] = []

  owner(): number | undefined {
    return this.#owners.at(-1)
  }

  ownerKind(): SymbolKind | undefined {
    const key = this.owner()
    return key === undefined ? undefined : this.map.symbols[key]?.kind
  }

  symbol(kind: SymbolKind, name: string, node: Node, options: SymbolOptions = {}): number {
    const key = this.map.symbols.length
    const parent = options.parent ?? this.owner()
    this.map.symbols.push({
      key,
      kind,
      name,
      ...(parent === undefined ? {} : { parent }),
      ...(options.container === undefined ? {} : { container: options.container }),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: options.exported ?? false,
      signature: signatureOf(node, options.body),
    })
    return key
  }

  within(key: number, visit: () => void): void {
    if (!OWNER_KINDS.has(this.map.symbols[key]?.kind ?? 'variable')) {
      visit()
      return
    }
    this.#owners.push(key)
    try {
      visit()
    } finally {
      this.#owners.pop()
    }
  }

  import(module: string, kind: ImportKind, node: Node, name?: string, alias?: string): void {
    this.map.imports.push({
      module,
      ...(name === undefined ? {} : { name }),
      ...(alias === undefined || alias === name ? {} : { alias }),
      kind,
      line: node.startPosition.row + 1,
    })
  }

  export(name: string, node: Node, local?: string, module?: string): void {
    this.map.exports.push({
      name,
      ...(local === undefined ? {} : { local }),
      ...(module === undefined ? {} : { module }),
      line: node.startPosition.row + 1,
    })
  }

  call(name: string, node: Node, qualifier?: Node | null, constructs = false): void {
    const caller = this.owner()
    this.map.calls.push({
      ...(caller === undefined ? {} : { caller }),
      name,
      ...(qualifier ? { qualifier: compact(qualifier.text, QUALIFIER_MAX_CHARS) } : {}),
      line: node.startPosition.row + 1,
      constructs,
    })
  }

  heritage(symbol: number, name: string, relation: HeritageRelation): void {
    this.map.heritage.push({ symbol, name, relation })
  }
}

export function stringValue(node: Node | null | undefined): string | undefined {
  if (!node) return undefined
  const fragment = node.namedChildren.find(
    (child) => child?.type === 'string_fragment' || child?.type === 'string_content',
  )
  if (fragment) return fragment.text
  const text = node.text
  return text.length >= 2 ? text.slice(1, -1) : undefined
}

function signatureOf(node: Node, body: Node | null | undefined): string {
  const text = node.text
  const header =
    body && text.endsWith(body.text) ? text.slice(0, text.length - body.text.length) : text
  return compact(header, SIGNATURE_MAX_CHARS)
}

function compact(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? single.slice(0, max) : single
}
