import type { SymbolKind } from '../repo-map/types.js'
import type { CallRow, IndexReader, ReferenceRow, SymbolRow } from '../store/index-reader.js'
import type { ObservedEdge, ObservedEndpoint } from '../store/observed-store.js'
import { loadProjectConfig } from './project-config.js'
import { NameResolver } from './resolve-name.js'
import { nameTokens, scoreSimilar, SIMILAR_MAX, SIMILAR_MIN_SCORE } from './similar.js'
import type { Features } from './similar.js'
import type { FileContext, NameSite, Resolution } from './resolve-name.js'
import type {
  CallersResult,
  DependenciesResult,
  Dependency,
  EdgeHow,
  EdgeKind,
  GraphSymbol,
  OpenGraphInput,
  RepositoryGraph,
  SimilarResult,
  SimilarSymbol,
  Site,
  SymbolTarget,
  Targets,
} from './types.js'

export const CALLER_CANDIDATES_MAX = 2_000
export const MAX_TARGETS = 3
export const SIMILAR_CANDIDATES_MAX = 500
export const QUERY_TIME_LIMIT_MS = 3_000

const OWNER_KINDS: ReadonlySet<SymbolKind> = new Set([
  'function',
  'method',
  'class',
  'struct',
  'interface',
  'type',
])
const KIND_RANK: Readonly<Record<string, number>> = {
  function: 0,
  method: 0,
  class: 0,
  struct: 0,
  interface: 1,
  type: 1,
}
const HOW_RANK: Readonly<Record<EdgeHow, number>> = { resolved: 0, inferred: 1, observed: 2 }

export async function openRepositoryGraph(input: OpenGraphInput): Promise<RepositoryGraph> {
  const config = await loadProjectConfig(input.reader.paths(), input.readText)
  return new IndexGraph(
    input.reader,
    new NameResolver(input.reader, config),
    input.readText,
    input.observed ?? [],
    input.now ?? (() => performance.now()),
  )
}

interface ObservedEnd {
  path: string
  symbol?: GraphSymbol
}

interface ValidObserved {
  from: ObservedEnd
  to: ObservedEnd
  pullRequest: number
}

class IndexGraph implements RepositoryGraph {
  readonly commit: string
  readonly #reader: IndexReader
  readonly #resolver: NameResolver
  readonly #readText: (path: string) => Promise<string>
  readonly #lines = new Map<string, Promise<string[] | undefined>>()
  readonly #observed: ValidObserved[] = []
  readonly #now: () => number

  constructor(
    reader: IndexReader,
    resolver: NameResolver,
    readText: (path: string) => Promise<string>,
    observed: readonly ObservedEdge[],
    now: () => number,
  ) {
    this.commit = reader.commit
    this.#now = now
    this.#reader = reader
    this.#resolver = resolver
    this.#readText = readText
    for (const edge of observed) {
      const from = this.#observedEnd(edge.from)
      const to = this.#observedEnd(edge.to)
      if (from === undefined || to === undefined) continue
      this.#observed.push({ from, to, pullRequest: edge.pullRequest })
    }
  }

  findSymbol(name: string, kind?: SymbolKind): GraphSymbol[] {
    const byName = (ignoreCase: boolean) =>
      this.#expand(this.#reader.symbolsNamed(name, { ignoreCase })).filter(
        (symbol) => symbol.kind !== 'parameter' && (kind === undefined || symbol.kind === kind),
      )
    const exact = byName(false)
    return sortDefinitions(exact.length > 0 ? exact : byName(true))
  }

  targets(target: SymbolTarget | GraphSymbol): Targets {
    if ('id' in target) return { symbols: [target], others: 0 }
    const found =
      target.path === undefined
        ? this.findSymbol(target.name)
        : sortDefinitions(
            (this.#resolver.context(target.path)?.symbols ?? [])
              .filter((symbol) => symbol.name === target.name && symbol.kind !== 'parameter')
              .map((symbol) => this.#resolver.graphSymbol(target.path ?? '', symbol)),
          )
    return { symbols: found.slice(0, MAX_TARGETS), others: Math.max(found.length - MAX_TARGETS, 0) }
  }

  callers(target: SymbolTarget | GraphSymbol): CallersResult {
    const targets = this.targets(target)
    const sites: Site[] = []
    let capped = false
    const deadline = this.#now() + QUERY_TIME_LIMIT_MS
    const outOfTime = () => {
      if (this.#now() <= deadline) return false
      capped = true
      return true
    }
    for (const symbol of targets.symbols) {
      const names = new Set([symbol.name])
      for (const item of this.#reader.importsNamed(symbol.name)) {
        if (item.alias !== undefined) names.add(item.alias)
      }
      let budget = CALLER_CANDIDATES_MAX
      for (const name of names) {
        const calls = this.#reader.callsNamed(name, budget)
        budget -= calls.length
        const references = this.#reader.referencesNamed(name, Math.max(budget, 0))
        budget -= references.length
        for (const row of calls) {
          if (outOfTime()) break
          sites.push(...this.#sitesTo(symbol, row, 'calls', row.callerId))
        }
        for (const row of references) {
          if (outOfTime()) break
          sites.push(...this.#sitesTo(symbol, row, 'uses', row.ownerId))
        }
        if (budget <= 0) {
          capped = true
          break
        }
      }
      for (const item of this.#reader.heritageNamed(symbol.name)) {
        const child = this.#reader.symbol(item.symbolId)
        if (child === undefined) continue
        for (const path of this.#reader.pathsOfBlob(child.blobId)) {
          const context = this.#resolver.context(path)
          if (context === undefined) continue
          const resolution = this.#resolver.resolveHeritage(context, item.name, child.startLine)
          if (!reaches(resolution, symbol)) continue
          sites.push({
            path,
            line: child.startLine,
            target: symbol,
            in: this.#resolver.graphSymbol(path, child, context),
            kind: 'inherits',
            how: resolution.how === 'inferred' ? 'inferred' : 'resolved',
          })
        }
      }
    }
    for (const symbol of targets.symbols) {
      for (const { other, pullRequest } of this.#observedOf(symbol)) {
        sites.push({
          path: other.path,
          line: other.symbol?.startLine ?? 1,
          target: symbol,
          ...(other.symbol === undefined ? {} : { in: other.symbol }),
          kind: 'related',
          how: 'observed',
          pullRequest,
        })
      }
    }
    return { ...targets, sites: sortSites(dedupeSites(sites)), capped }
  }

  dependencies(target: SymbolTarget | GraphSymbol): DependenciesResult {
    const targets = this.targets(target)
    const dependencies: Dependency[] = []
    for (const symbol of targets.symbols) {
      const context = this.#resolver.context(symbol.path)
      if (context === undefined) continue
      const inside = this.#within(context, symbol)
      const sites: { site: NameSite; kind: EdgeKind }[] = [
        ...this.#reader
          .callsOfBlob(context.blobId)
          .filter((row) => inside(row.callerId, row.line))
          .map((row) => ({ site: siteOf(row, row.callerId), kind: 'calls' as const })),
        ...this.#reader
          .referencesOfBlob(context.blobId)
          .filter((row) => inside(row.ownerId, row.line))
          .map((row) => ({ site: siteOf(row, row.ownerId), kind: 'uses' as const })),
      ]
      for (const { site, kind } of sites) {
        dependencies.push(
          ...[
            toDependency(site.name, site.line, kind, this.#resolver.resolve(context, site)),
          ].flat(),
        )
      }
      for (const item of this.#reader.heritageOfBlob(context.blobId)) {
        if (item.symbolId !== symbol.id) continue
        const resolution = this.#resolver.resolveHeritage(context, item.name, symbol.startLine)
        dependencies.push(
          ...[toDependency(item.name, symbol.startLine, 'inherits', resolution)].flat(),
        )
      }
    }
    for (const symbol of targets.symbols) {
      for (const { other, pullRequest } of this.#observedOf(symbol)) {
        dependencies.push({
          name: other.symbol?.name ?? other.path,
          line: symbol.startLine,
          kind: 'related',
          how: 'observed',
          ...(other.symbol === undefined ? { module: other.path } : { target: other.symbol }),
          pullRequest,
        })
      }
    }
    return { ...targets, dependencies: dedupeDependencies(dependencies) }
  }

  similar(target: SymbolTarget | GraphSymbol): SimilarResult {
    const targets = this.targets(target)
    const similar: SimilarSymbol[] = []
    for (const symbol of targets.symbols) {
      if (symbol.kind !== 'function' && symbol.kind !== 'method') continue
      const context = this.#resolver.context(symbol.path)
      const row = context?.byId.get(symbol.id)
      if (context === undefined || row === undefined) continue
      const wanted = this.#features(context, row)
      const candidates = new Map<string, { path: string; row: SymbolRow }>()
      const add = (path: string, candidate: SymbolRow) => {
        if (candidate.kind !== symbol.kind || (candidate.id === symbol.id && path === symbol.path))
          return
        candidates.set(`${path}:${candidate.id}`, { path, row: candidate })
      }
      for (const id of this.#reader.callersOfNames([...wanted.calls], SIMILAR_CANDIDATES_MAX)) {
        const candidate = this.#reader.symbol(id)
        if (candidate === undefined) continue
        for (const path of this.#reader.pathsOfBlob(candidate.blobId)) add(path, candidate)
      }
      for (const sibling of context.symbols) {
        if (sibling.parentId === row.parentId) add(symbol.path, sibling)
      }
      for (const { path, row: candidate } of candidates.values()) {
        const other = this.#resolver.context(path)
        if (other === undefined) continue
        const { score, shared } = scoreSimilar(wanted, this.#features(other, candidate))
        if (score < SIMILAR_MIN_SCORE) continue
        similar.push({ symbol: this.#resolver.graphSymbol(path, candidate, other), score, shared })
      }
    }
    similar.sort((a, b) => b.score - a.score || (a.symbol.path < b.symbol.path ? -1 : 1))
    return { ...targets, similar: similar.slice(0, SIMILAR_MAX) }
  }

  symbolAt(path: string, line: number): GraphSymbol | undefined {
    const context = this.#resolver.context(path)
    if (context === undefined) return undefined
    const containing = context.symbols.filter(
      (symbol) =>
        symbol.kind !== 'parameter' &&
        !(symbol.kind === 'variable' && symbol.parentId !== undefined) &&
        symbol.startLine <= line &&
        line <= symbol.endLine,
    )
    const innermost = containing.sort(
      (a, b) => a.endLine - a.startLine - (b.endLine - b.startLine) || b.startLine - a.startLine,
    )[0]
    return innermost === undefined
      ? undefined
      : this.#resolver.graphSymbol(path, innermost, context)
  }

  async lineText(path: string, line: number): Promise<string | undefined> {
    let lines = this.#lines.get(path)
    if (lines === undefined) {
      lines = this.#readText(path).then(
        (text) => text.split('\n'),
        () => undefined,
      )
      this.#lines.set(path, lines)
    }
    return (await lines)?.[line - 1]
  }

  #sitesTo(
    target: GraphSymbol,
    row: CallRow | ReferenceRow,
    kind: EdgeKind,
    ownerId: number | undefined,
  ): Site[] {
    const found: Site[] = []
    for (const path of this.#reader.pathsOfBlob(row.blobId)) {
      const context = this.#resolver.context(path)
      if (context === undefined) continue
      const resolution = this.#resolver.resolve(context, siteOf(row, ownerId))
      if (!reaches(resolution, target)) continue
      const owner = ownerId === undefined ? undefined : context.byId.get(ownerId)
      found.push({
        path,
        line: row.line,
        target,
        ...(owner === undefined ? {} : { in: this.#resolver.graphSymbol(path, owner, context) }),
        kind,
        how: resolution.how === 'inferred' ? 'inferred' : 'resolved',
      })
    }
    return found
  }

  #within(
    context: FileContext,
    symbol: GraphSymbol,
  ): (ownerId: number | undefined, line: number) => boolean {
    if (!OWNER_KINDS.has(symbol.kind)) {
      const row = context.byId.get(symbol.id)
      return (ownerId, line) =>
        ownerId === row?.parentId && symbol.startLine <= line && line <= symbol.endLine
    }
    const inside = new Set([symbol.id])
    let grew = true
    while (grew) {
      grew = false
      for (const row of context.symbols) {
        if (row.parentId !== undefined && inside.has(row.parentId) && !inside.has(row.id)) {
          if (row.kind === 'method' && symbol.kind !== 'method' && symbol.kind !== 'function')
            continue
          inside.add(row.id)
          grew = true
        }
      }
    }
    return (ownerId) => ownerId !== undefined && inside.has(ownerId)
  }

  #observedOf(symbol: GraphSymbol): { other: ObservedEnd; pullRequest: number }[] {
    const same = (end: ObservedEnd) =>
      end.symbol !== undefined && end.symbol.path === symbol.path && end.symbol.id === symbol.id
    return this.#observed.flatMap((edge) =>
      same(edge.from)
        ? [{ other: edge.to, pullRequest: edge.pullRequest }]
        : same(edge.to)
          ? [{ other: edge.from, pullRequest: edge.pullRequest }]
          : [],
    )
  }

  #observedEnd(point: ObservedEndpoint): ObservedEnd | undefined {
    if (!this.#reader.paths().has(point.path)) return undefined
    if (point.name === undefined) return { path: point.path }
    const context = this.#resolver.context(point.path)
    const row = context?.symbols.find((candidate) => {
      if (candidate.name !== point.name || candidate.kind !== point.kind) return false
      return this.#resolver.graphSymbol(point.path, candidate, context).owner === point.owner
    })
    return row === undefined
      ? undefined
      : { path: point.path, symbol: this.#resolver.graphSymbol(point.path, row, context) }
  }

  #features(context: FileContext, row: SymbolRow): Features {
    const parent = row.parentId === undefined ? undefined : context.byId.get(row.parentId)
    return {
      kind: row.kind,
      calls: new Set(
        this.#reader
          .callsOfBlob(context.blobId)
          .filter((call) => call.callerId === row.id)
          .map((call) => call.name),
      ),
      parameters: context.symbols.filter(
        (symbol) => symbol.parentId === row.id && symbol.kind === 'parameter',
      ).length,
      nameTokens: nameTokens(row.name),
      ...(parent === undefined ? {} : { ownerKind: parent.kind }),
    }
  }

  #expand(rows: readonly SymbolRow[]): GraphSymbol[] {
    return rows.flatMap((row) =>
      this.#reader.pathsOfBlob(row.blobId).map((path) => this.#resolver.graphSymbol(path, row)),
    )
  }
}

function siteOf(row: CallRow | ReferenceRow, ownerId: number | undefined): NameSite {
  return {
    name: row.name,
    ...(row.qualifier === undefined ? {} : { qualifier: row.qualifier }),
    ...(ownerId === undefined ? {} : { ownerId }),
    line: row.line,
  }
}

function reaches(resolution: Resolution, target: GraphSymbol): boolean {
  return (
    resolution.how !== 'external' &&
    resolution.symbols.some((symbol) => symbol.id === target.id && symbol.path === target.path)
  )
}

function toDependency(
  name: string,
  line: number,
  kind: EdgeKind,
  resolution: Resolution,
): Dependency[] | Dependency {
  if (resolution.how === 'external') {
    return {
      name,
      line,
      kind,
      how: 'resolved',
      ...(resolution.module === undefined ? {} : { module: resolution.module }),
    }
  }
  return resolution.symbols.map((target) => ({ name, line, kind, how: resolution.how, target }))
}

function dedupeDependencies(items: readonly Dependency[]): Dependency[] {
  const seen = new Set<string>()
  const result: Dependency[] = []
  for (const item of items) {
    const key = `${item.name}\0${item.kind}\0${item.target?.path ?? ''}:${item.target?.id ?? item.module ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result.sort((a, b) => a.line - b.line)
}

function dedupeSites(sites: readonly Site[]): Site[] {
  const seen = new Set<string>()
  return sites.filter((site) => {
    const key = `${site.path}:${site.line}:${site.kind}:${site.target.path}:${site.target.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function sortSites(sites: readonly Site[]): Site[] {
  return [...sites].sort(
    (a, b) =>
      HOW_RANK[a.how] - HOW_RANK[b.how] ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      a.line - b.line,
  )
}

function sortDefinitions(symbols: readonly GraphSymbol[]): GraphSymbol[] {
  return [...symbols].sort(
    (a, b) =>
      Number(b.exported) - Number(a.exported) ||
      (KIND_RANK[a.kind] ?? 2) - (KIND_RANK[b.kind] ?? 2) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      a.startLine - b.startLine,
  )
}
