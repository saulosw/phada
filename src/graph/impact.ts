import { parseDiffFiles } from '../review/diff-lines.js'
import type {
  DiffImpact,
  ImpactCode,
  ImpactDependency,
  ImpactPlace,
  ImpactSimilar,
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
export const IMPACT_REPEATED_SITES = 300
export const IMPACT_REPEATED_PLACES = 2
export const IMPACT_SIMILAR_SYMBOLS = 5
export const IMPACT_SIMILAR_LIKE = 3

const HOW_RANK: Readonly<Record<Site['how'], number>> = { resolved: 0, inferred: 1, observed: 2 }
const CALLABLE_KINDS: ReadonlySet<string> = new Set(['function', 'method'])
const CHANGE_GROUP = { existing: 0, newExported: 1, new: 2 } as const
const RECEIVER_SEPARATOR = /\?\.|->|::|\./
const TRAILING_CALL_OR_INDEX = /(\([^()]*\)|\[[^[\]]*\])+$/
const TRAILING_IDENTIFIER = /[A-Za-z_$][\w$]*$/
const TEST_PATH =
  /(^|\/)(tests?|__tests__|spec|testdata)\/|[._-](test|spec)\.[^/]+$|_test\.go$|(^|\/)test_[^/]+\.py$/

export interface ChangedLines {
  path: string
  lines: number[]
  added: number[]
}

export function changedLines(diff: string): ChangedLines[] {
  return parseDiffFiles(diff)
    .filter((file) => file.status !== 'deleted' && file.status !== 'binary')
    .map((file) => ({
      path: file.path,
      lines: [...new Set([...file.added, ...file.removedAt])].sort((a, b) => a - b),
      added: [...file.added].sort((a, b) => a - b),
    }))
    .filter((file) => file.lines.length > 0)
}

export interface ImpactOptions {
  now?: () => number
  createsCode?: boolean
}

export async function computeImpact(
  graph: RepositoryGraph,
  changed: readonly ChangedLines[],
  options: ImpactOptions = {},
): Promise<DiffImpact> {
  const now = options.now ?? (() => performance.now())
  const deadline = now() + IMPACT_TIME_LIMIT_MS
  const outOfTime = () => now() > deadline
  const changedByPath = new Map(changed.map((file) => [file.path, new Set(file.lines)]))
  const addedByPath = new Map(changed.map((file) => [file.path, new Set(file.added)]))
  const touched = new Map<string, { symbol: GraphSymbol; lines: number; group: ChangeGroup }>()
  for (const { path, lines } of changed) {
    for (const line of lines) {
      const symbol = graph.symbolAt(path, line) ?? graph.symbolAt(path, line - 1)
      if (symbol === undefined) continue
      const key = `${symbol.path}:${symbol.id}`
      const entry = touched.get(key) ?? {
        symbol,
        lines: 0,
        group: changeGroup(symbol, addedByPath),
      }
      entry.lines += 1
      touched.set(key, entry)
    }
  }
  const ordered = [...touched.values()].sort(
    (a, b) =>
      a.group - b.group ||
      Number(b.symbol.exported) - Number(a.symbol.exported) ||
      b.lines - a.lines ||
      (a.symbol.path < b.symbol.path ? -1 : a.symbol.path > b.symbol.path ? 1 : 0) ||
      a.symbol.startLine - b.symbol.startLine,
  )
  const symbols: ImpactedSymbol[] = []
  const callerFiles = new Set<string>()
  for (const { symbol } of ordered.slice(0, IMPACT_MAX_SYMBOLS)) {
    if (symbols.length > 0 && outOfTime()) break
    const { impacted, files } = await impactOf(graph, symbol, changedByPath, outOfTime)
    symbols.push(impacted)
    for (const file of files) callerFiles.add(file)
  }
  const fresh = ordered
    .filter(
      ({ symbol, group }) => group === CHANGE_GROUP.newExported && CALLABLE_KINDS.has(symbol.kind),
    )
    .slice(0, IMPACT_SIMILAR_SYMBOLS)
    .map(({ symbol }) => symbol)
  const similar =
    options.createsCode === true ? similarCode(graph, fresh, addedByPath, outOfTime) : []
  return {
    symbols: [
      ...symbols.filter((symbol) => symbol.callers > 0),
      ...symbols.filter((symbol) => symbol.callers === 0),
    ],
    omittedSymbols: ordered.length - symbols.length,
    callerFiles: callerFiles.size,
    ...(similar.length === 0 ? {} : { similar }),
  }
}

type ChangeGroup = (typeof CHANGE_GROUP)[keyof typeof CHANGE_GROUP]

function changeGroup(
  symbol: GraphSymbol,
  addedByPath: ReadonlyMap<string, ReadonlySet<number>>,
): ChangeGroup {
  const added = addedByPath.get(symbol.path)
  if (!rangeWithin(symbol, (line) => added?.has(line) === true)) return CHANGE_GROUP.existing
  return symbol.exported ? CHANGE_GROUP.newExported : CHANGE_GROUP.new
}

function rangeWithin(symbol: GraphSymbol, accepts: (line: number) => boolean): boolean {
  for (let line = symbol.startLine; line <= symbol.endLine; line += 1) {
    if (!accepts(line)) return false
  }
  return true
}

function similarCode(
  graph: RepositoryGraph,
  fresh: readonly GraphSymbol[],
  addedByPath: ReadonlyMap<string, ReadonlySet<number>>,
  outOfTime: () => boolean,
): ImpactSimilar[] {
  const existing = (symbol: GraphSymbol) => {
    const added = addedByPath.get(symbol.path)
    return added === undefined || rangeWithin(symbol, (line) => !added.has(line))
  }
  const found: ImpactSimilar[] = []
  for (const symbol of fresh) {
    if (outOfTime()) break
    const like = graph
      .similar(symbol)
      .similar.filter((item) => existing(item.symbol))
      .slice(0, IMPACT_SIMILAR_LIKE)
      .map((item) => ({ ...codeOf(item.symbol), score: item.score, shared: item.shared }))
    if (like.length > 0) found.push({ symbol: codeOf(symbol), like })
  }
  return found
}

function codeOf(symbol: GraphSymbol): ImpactCode {
  return {
    kind: symbol.kind,
    name: symbol.name,
    path: symbol.path,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
  }
}

function receiverNamesOwner(receiver: string | undefined, owner: string | undefined): boolean {
  if (receiver === undefined || owner === undefined) return false
  const last = (receiver.split(RECEIVER_SEPARATOR).at(-1) ?? '').trim()
  const name = TRAILING_IDENTIFIER.exec(last.replace(TRAILING_CALL_OR_INDEX, ''))?.[0]
  return name !== undefined && looseName(name) === looseName(owner)
}

function looseName(name: string): string {
  return name.replaceAll('_', '').toLowerCase()
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

async function repeatedUses(
  sites: readonly Site[],
  textOf: (site: Site) => Promise<string>,
  outOfTime: () => boolean,
): Promise<Map<Site, Site[]>> {
  const byText = new Map<string, Site[]>()
  for (const site of sites) {
    if (outOfTime()) break
    const text = (await textOf(site)).replace(/\s+/g, ' ')
    if (text === '') continue
    const key = `${site.kind}\0${site.how}\0${text}`
    const same = byText.get(key) ?? []
    same.push(site)
    byText.set(key, same)
  }
  const groups = new Map<Site, Site[]>()
  for (const [first, ...rest] of byText.values()) {
    if (first === undefined || new Set([first, ...rest].map(fileKey)).size < 2) continue
    groups.set(first, rest)
  }
  return groups
}

function placeOf(site: Site): ImpactPlace {
  return {
    ...(site.repo === undefined ? {} : { repo: site.repo }),
    path: site.path,
    line: site.line,
  }
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
  outOfTime: () => boolean,
): Promise<{ impacted: ImpactedSymbol; files: Set<string> }> {
  const found = graph.callers(symbol)
  const inDiff = (site: Site) => site.repo === undefined && changedByPath.has(site.path)
  const outside = found.sites.filter(
    (site) => site.repo !== undefined || changedByPath.get(site.path)?.has(site.line) !== true,
  )
  let onlyDefinition: boolean | undefined
  const believable = (site: Site) => {
    if (site.how !== 'inferred' || receiverNamesOwner(site.receiver, symbol.owner)) return true
    onlyDefinition ??=
      graph.findSymbol(symbol.name).filter((each) => CALLABLE_KINDS.has(each.kind)).length === 1
    return onlyDefinition
  }
  const sites = outside.filter(believable)
  const unresolved = outside.length - sites.length
  sites.sort(
    (a, b) =>
      Number(TEST_PATH.test(a.path)) - Number(TEST_PATH.test(b.path)) ||
      HOW_RANK[a.how] - HOW_RANK[b.how] ||
      Number(inDiff(a)) - Number(inDiff(b)) ||
      (a.repo ?? '').localeCompare(b.repo ?? '') ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      a.line - b.line,
  )
  const texts = new Map<Site, string>()
  const textOf = async (site: Site) => {
    const known = texts.get(site)
    if (known !== undefined) return known
    const text = ((await graph.lineText(site.path, site.line, site.repo)) ?? '')
      .trim()
      .slice(0, IMPACT_LINE_CHARS)
    texts.set(site, text)
    return text
  }
  const repeated = await repeatedUses(sites.slice(0, IMPACT_REPEATED_SITES), textOf, outOfTime)
  const absorbed = new Set([...repeated.values()].flat())
  const kept = keepSites(sites.filter((site) => !absorbed.has(site)))
  const impactSites: ImpactSite[] = []
  for (const site of kept) {
    const text = await textOf(site)
    const same = repeated.get(site)
    impactSites.push({
      ...(site.repo === undefined ? {} : { repo: site.repo }),
      path: site.path,
      line: site.line,
      ...(site.in === undefined ? {} : { in: site.in.name }),
      kind: site.kind,
      how: site.how,
      ...(site.pullRequest === undefined ? {} : { pullRequest: site.pullRequest }),
      text,
      ...(same === undefined
        ? {}
        : {
            repeated: {
              uses: same.length + 1,
              files: new Set([site, ...same].map(fileKey)).size,
              also: same.slice(0, IMPACT_REPEATED_PLACES).map(placeOf),
            },
          }),
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
    ...(unresolved === 0 ? {} : { unresolved }),
    ...(found.capped ? { capped: true } : {}),
    sites: impactSites,
    dependencies,
    ...relatedReach(sites, allDependencies),
  }
  return { impacted, files }
}
