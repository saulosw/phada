import { parseDiffFiles } from '../review/diff-lines.js'
import type {
  DiffImpact,
  ImpactDependency,
  ImpactSite,
  ImpactedSymbol,
  RelatedReach,
} from '../review/types.js'
import type { Dependency, GraphSymbol, RepositoryGraph, Site } from './types.js'

export const IMPACT_MAX_SYMBOLS = 20
export const IMPACT_SITES_PER_FILE = 3
export const IMPACT_SITES_PER_SYMBOL = 30
export const IMPACT_DEPENDENCIES = 5
export const IMPACT_LINE_CHARS = 200
export const IMPACT_TIME_LIMIT_MS = 10_000

const HOW_RANK: Readonly<Record<Site['how'], number>> = { resolved: 0, inferred: 1, observed: 2 }
const TEST_PATH =
  /(^|\/)(tests?|__tests__|spec|testdata)\/|[._-](test|spec)\.[^/]+$|_test\.go$|(^|\/)test_[^/]+\.py$/

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

export interface ImpactOptions {
  now?: () => number
}

export async function computeImpact(
  graph: RepositoryGraph,
  changed: readonly ChangedLines[],
  options: ImpactOptions = {},
): Promise<DiffImpact> {
  const now = options.now ?? (() => performance.now())
  const deadline = now() + IMPACT_TIME_LIMIT_MS
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
    if (symbols.length > 0 && now() > deadline) break
    const { impacted, files } = await impactOf(graph, symbol, changedByPath)
    symbols.push(impacted)
    for (const file of files) callerFiles.add(file)
  }
  return {
    symbols: [
      ...symbols.filter((symbol) => symbol.callers > 0),
      ...symbols.filter((symbol) => symbol.callers === 0),
    ],
    omittedSymbols: ordered.length - symbols.length,
    callerFiles: callerFiles.size,
  }
}

function relatedReach(
  sites: readonly Site[],
  dependencies: readonly Dependency[],
): { related?: RelatedReach[] } {
  const reach = new Map<string, RelatedReach>()
  const entry = (repo: string) => {
    const known = reach.get(repo) ?? { repo, callers: 0, uses: 0 }
    reach.set(repo, known)
    return known
  }
  for (const site of sites) if (site.repo !== undefined) entry(site.repo).callers += 1
  const used = new Set<string>()
  for (const item of dependencies) {
    const target = item.target
    if (target?.repo === undefined) continue
    const key = `${target.repo}:${target.path}:${target.id}`
    if (used.has(key)) continue
    used.add(key)
    entry(target.repo).uses += 1
  }
  return reach.size === 0 ? {} : { related: [...reach.values()] }
}

function fileKey(site: Site): string {
  return `${site.repo ?? ''}\0${site.path}`
}

function keepSites(sites: readonly Site[]): Site[] {
  const perFile = new Map<string, number>()
  const chosen = new Set<number>()
  const take = (index: number) => {
    const site = sites[index]
    if (site === undefined) return
    perFile.set(fileKey(site), (perFile.get(fileKey(site)) ?? 0) + 1)
    chosen.add(index)
  }
  const repos = new Set<string>()
  const guaranteed: number[] = []
  sites.forEach((site, index) => {
    if (site.repo === undefined || repos.has(site.repo)) return
    repos.add(site.repo)
    guaranteed.push(index)
    take(index)
  })
  sites.forEach((site, index) => {
    if (chosen.has(index) || chosen.size >= IMPACT_SITES_PER_SYMBOL) return
    if ((perFile.get(fileKey(site)) ?? 0) >= IMPACT_SITES_PER_FILE) return
    take(index)
  })
  const first = new Set(guaranteed)
  return [
    ...guaranteed.flatMap((index) => sites[index] ?? []),
    ...sites.filter((_, index) => chosen.has(index) && !first.has(index)),
  ]
}

async function impactOf(
  graph: RepositoryGraph,
  symbol: GraphSymbol,
  changedByPath: ReadonlyMap<string, ReadonlySet<number>>,
): Promise<{ impacted: ImpactedSymbol; files: Set<string> }> {
  const found = graph.callers(symbol)
  const inDiff = (site: Site) => site.repo === undefined && changedByPath.has(site.path)
  const sites = found.sites
    .filter(
      (site) => site.repo !== undefined || changedByPath.get(site.path)?.has(site.line) !== true,
    )
    .sort(
      (a, b) =>
        Number(TEST_PATH.test(a.path)) - Number(TEST_PATH.test(b.path)) ||
        HOW_RANK[a.how] - HOW_RANK[b.how] ||
        Number(inDiff(a)) - Number(inDiff(b)) ||
        (a.repo ?? '').localeCompare(b.repo ?? '') ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
        a.line - b.line,
    )
  const kept = keepSites(sites)
  const impactSites: ImpactSite[] = []
  for (const site of kept) {
    const text = ((await graph.lineText(site.path, site.line, site.repo)) ?? '')
      .trim()
      .slice(0, IMPACT_LINE_CHARS)
    impactSites.push({
      ...(site.repo === undefined ? {} : { repo: site.repo }),
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
  const allDependencies = graph.dependencies(symbol).dependencies
  for (const item of allDependencies) {
    const target = item.target
    if (target === undefined || item.how === 'observed') continue
    if (target.repo === undefined && target.path === symbol.path) continue
    const key = `${target.repo ?? ''}:${target.path}:${target.id}`
    if (seen.has(key) || dependencies.length >= IMPACT_DEPENDENCIES) continue
    seen.add(key)
    dependencies.push({
      name: item.name,
      ...(target.repo === undefined ? {} : { repo: target.repo }),
      path: target.path,
      line: target.startLine,
      kind: target.kind,
    })
  }
  const files = new Set(sites.map(fileKey))
  const impacted: ImpactedSymbol = {
    kind: symbol.kind,
    name: symbol.name,
    path: symbol.path,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    exported: symbol.exported,
    callers: sites.length,
    files: files.size,
    ...(found.capped ? { capped: true } : {}),
    sites: impactSites,
    dependencies,
    ...relatedReach(sites, allDependencies),
  }
  return { impacted, files }
}
