import { parseDiffFiles } from '../review/diff-lines.js'
import type { DiffImpact, ImpactDependency, ImpactSite, ImpactedSymbol } from '../review/types.js'
import type { GraphSymbol, RepositoryGraph, Site } from './types.js'

export const IMPACT_MAX_SYMBOLS = 20
export const IMPACT_SITES_PER_FILE = 3
export const IMPACT_SITES_PER_SYMBOL = 30
export const IMPACT_DEPENDENCIES = 5
export const IMPACT_LINE_CHARS = 200

const HOW_RANK: Readonly<Record<Site['how'], number>> = { resolved: 0, inferred: 1, observed: 2 }

export interface ChangedLines {
  path: string
  lines: number[]
}

export function changedLines(diff: string): ChangedLines[] {
  return parseDiffFiles(diff)
    .filter((file) => file.status !== 'deleted' && file.status !== 'binary')
    .map((file) => ({
      path: file.path,
      lines: [...new Set([...file.added, ...file.removedAt])].sort((a, b) => a - b),
    }))
    .filter((file) => file.lines.length > 0)
}

export async function computeImpact(
  graph: RepositoryGraph,
  changed: readonly ChangedLines[],
): Promise<DiffImpact> {
  const changedByPath = new Map(changed.map((file) => [file.path, new Set(file.lines)]))
  const touched = new Map<string, { symbol: GraphSymbol; lines: number }>()
  for (const { path, lines } of changed) {
    for (const line of lines) {
      const symbol = graph.symbolAt(path, line) ?? graph.symbolAt(path, line - 1)
      if (symbol === undefined) continue
      const key = `${symbol.path}:${symbol.id}`
      const entry = touched.get(key) ?? { symbol, lines: 0 }
      entry.lines += 1
      touched.set(key, entry)
    }
  }
  const ordered = [...touched.values()].sort(
    (a, b) =>
      Number(b.symbol.exported) - Number(a.symbol.exported) ||
      b.lines - a.lines ||
      (a.symbol.path < b.symbol.path ? -1 : a.symbol.path > b.symbol.path ? 1 : 0) ||
      a.symbol.startLine - b.symbol.startLine,
  )
  const symbols: ImpactedSymbol[] = []
  const callerFiles = new Set<string>()
  for (const { symbol } of ordered.slice(0, IMPACT_MAX_SYMBOLS)) {
    const { impacted, files } = await impactOf(graph, symbol, changedByPath)
    symbols.push(impacted)
    for (const file of files) callerFiles.add(file)
  }
  return {
    symbols,
    omittedSymbols: Math.max(ordered.length - IMPACT_MAX_SYMBOLS, 0),
    callerFiles: callerFiles.size,
  }
}

async function impactOf(
  graph: RepositoryGraph,
  symbol: GraphSymbol,
  changedByPath: ReadonlyMap<string, ReadonlySet<number>>,
): Promise<{ impacted: ImpactedSymbol; files: Set<string> }> {
  const sites = graph
    .callers(symbol)
    .sites.filter((site) => changedByPath.get(site.path)?.has(site.line) !== true)
    .sort(
      (a, b) =>
        HOW_RANK[a.how] - HOW_RANK[b.how] ||
        Number(changedByPath.has(a.path)) - Number(changedByPath.has(b.path)) ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
        a.line - b.line,
    )
  const perFile = new Map<string, number>()
  const kept: Site[] = []
  for (const site of sites) {
    const count = perFile.get(site.path) ?? 0
    if (count >= IMPACT_SITES_PER_FILE || kept.length >= IMPACT_SITES_PER_SYMBOL) continue
    perFile.set(site.path, count + 1)
    kept.push(site)
  }
  const impactSites: ImpactSite[] = []
  for (const site of kept) {
    const text = ((await graph.lineText(site.path, site.line)) ?? '')
      .trim()
      .slice(0, IMPACT_LINE_CHARS)
    impactSites.push({
      path: site.path,
      line: site.line,
      ...(site.in === undefined ? {} : { in: site.in.name }),
      kind: site.kind,
      how: site.how,
      ...(site.pullRequest === undefined ? {} : { pullRequest: site.pullRequest }),
      text,
    })
  }
  const dependencies: ImpactDependency[] = []
  const seen = new Set<string>()
  for (const item of graph.dependencies(symbol).dependencies) {
    const target = item.target
    if (target === undefined || target.path === symbol.path || item.how === 'observed') continue
    const key = `${target.path}:${target.id}`
    if (seen.has(key) || dependencies.length >= IMPACT_DEPENDENCIES) continue
    seen.add(key)
    dependencies.push({
      name: item.name,
      path: target.path,
      line: target.startLine,
      kind: target.kind,
    })
  }
  const files = new Set(sites.map((site) => site.path))
  const impacted: ImpactedSymbol = {
    kind: symbol.kind,
    name: symbol.name,
    path: symbol.path,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    exported: symbol.exported,
    callers: sites.length,
    files: files.size,
    sites: impactSites,
    dependencies,
  }
  return { impacted, files }
}
