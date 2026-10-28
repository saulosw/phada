import type { ConfigLayer } from '../config/types.js'
import { linkGraphs } from '../graph/linked-graph.js'
import { openRepositoryGraph } from '../graph/repository-graph.js'
import { hasLink, linkRepositories } from '../graph/repository-links.js'
import type { RepositoryLink } from '../graph/repository-links.js'
import type {
  Dependency,
  EdgeHow,
  EdgeKind,
  GraphSymbol,
  RepositoryGraph,
  Site,
} from '../graph/types.js'
import type { ObservedEdge } from '../store/observed-store.js'
import { declaredRelated, indexedSnapshot, openLocalRepository } from './local-repository.js'
import type { LocalReaders, LocalRepository, NotIndexed } from './local-repository.js'

export type { EdgeHow, EdgeKind } from '../graph/types.js'
export type { NotIndexed } from './local-repository.js'

export const LEVEL_MAX = 20

export interface ExplorerReaders extends LocalReaders {
  userLayers(repo: string): Promise<ConfigLayer[]>
  readObserved(repo: string): Promise<ObservedEdge[]>
}

export interface ExploredSymbol {
  repo: string
  path: string
  id: number
  line: number
  endLine: number
  kind: GraphSymbol['kind']
  name: string
  owner?: string
  signature: string
  exported: boolean
}

export interface DefinitionList {
  definitions: ExploredSymbol[]
  more: number
}

export interface CallerSite {
  repo: string
  path: string
  line: number
  in?: ExploredSymbol
  kind: EdgeKind
  how: EdgeHow
  pullRequest?: number
}

export interface CallerList {
  sites: CallerSite[]
  more: number
  capped: boolean
}

export interface DependencyEntry {
  name: string
  line: number
  kind: EdgeKind
  how: EdgeHow
  target?: ExploredSymbol
  module?: string
  pullRequest?: number
}

export interface DependencyList {
  dependencies: DependencyEntry[]
  more: number
}

export interface GraphExplorer {
  readonly repo: string
  readonly commit: string
  readonly linked: readonly string[]
  search(name: string): DefinitionList
  callers(symbol: ExploredSymbol): CallerList
  dependencies(symbol: ExploredSymbol): DependencyList
  close(): void
}

export type GraphOpening =
  { state: 'open'; explorer: GraphExplorer } | { state: 'not-indexed'; why: NotIndexed }

export type Explored<T> =
  | { state: 'read'; repo: string; commit: string; linked: readonly string[]; result: T }
  | { state: 'not-indexed'; why: NotIndexed }

interface OpenedRepository {
  repo: string
  local: LocalRepository
  graph: RepositoryGraph
}

export async function openGraphExplorer(
  repo: string,
  readers: ExplorerReaders,
): Promise<GraphOpening> {
  const source = await openRepository(repo, readers)
  if ('reason' in source) return { state: 'not-indexed', why: source }
  const opened = [source]
  try {
    const layers = await readers.userLayers(repo).catch(() => [])
    const declared = declaredRelated(repo, layers, source.local.config).related
    const linked: { item: OpenedRepository; link: RepositoryLink }[] = []
    for (const { repo: name } of declared) {
      const other = await openRepository(name, readers)
      if ('reason' in other) continue
      opened.push(other)
      const link = linkRepositories(source.local.packages, other.local.packages)
      if (hasLink(link)) linked.push({ item: other, link })
    }
    const graphs = new Map<string, RepositoryGraph>([
      [
        source.repo,
        linkGraphs(
          source.graph,
          linked.map(({ item, link }) => ({ repo: item.repo, graph: item.graph, link })),
        ),
      ],
      ...linked.map(({ item, link }): [string, RepositoryGraph] => [
        item.repo,
        linkGraphs(item.graph, [{ repo: source.repo, graph: source.graph, link: reversed(link) }]),
      ]),
    ])
    return {
      state: 'open',
      explorer: explorer(
        source,
        graphs,
        linked.map(({ item }) => item.repo),
        () => {
          for (const item of opened) item.local.index.close()
        },
      ),
    }
  } catch (error) {
    for (const item of opened) item.local.index.close()
    throw error
  }
}

export async function indexedCommit(
  repo: string,
  readers: Pick<LocalReaders, 'openIndex'>,
): Promise<string | undefined> {
  const snapshot = await indexedSnapshot(repo, readers)
  return typeof snapshot === 'string' ? snapshot : undefined
}

async function openRepository(
  repo: string,
  readers: ExplorerReaders,
): Promise<OpenedRepository | NotIndexed> {
  const opening = await openLocalRepository(repo, readers)
  if (opening.state === 'not-indexed') return opening.why
  const { local } = opening
  try {
    const graph = await openRepositoryGraph({
      reader: local.index.reader(local.commit),
      readText: local.readText,
      observed: await readers.readObserved(repo).catch(() => []),
    })
    return { repo, local, graph }
  } catch (error) {
    local.index.close()
    throw error
  }
}

function reversed(link: RepositoryLink): RepositoryLink {
  return { consumedByRelated: link.consumedByReviewed, consumedByReviewed: link.consumedByRelated }
}

function explorer(
  source: OpenedRepository,
  graphs: ReadonlyMap<string, RepositoryGraph>,
  linked: readonly string[],
  close: () => void,
): GraphExplorer {
  const graphOf = (repo: string) => graphs.get(repo)
  return {
    repo: source.repo,
    commit: source.local.commit,
    linked,
    search: (name) => {
      const found = source.graph.findSymbol(name).map((symbol) => explored(symbol, source.repo))
      return { definitions: found.slice(0, LEVEL_MAX), more: left(found) }
    },
    callers: (symbol) => {
      const graph = graphOf(symbol.repo)
      if (graph === undefined) return { sites: [], more: 0, capped: false }
      const found = graph.callers(graphSymbol(symbol))
      const sites = found.sites.map((site) => callerSite(site, symbol.repo))
      return { sites: sites.slice(0, LEVEL_MAX), more: left(sites), capped: found.capped }
    },
    dependencies: (symbol) => {
      const graph = graphOf(symbol.repo)
      if (graph === undefined) return { dependencies: [], more: 0 }
      const found = graph
        .dependencies(graphSymbol(symbol))
        .dependencies.map((item) => dependencyEntry(item, symbol.repo))
      return { dependencies: found.slice(0, LEVEL_MAX), more: left(found) }
    },
    close,
  }
}

function left(items: readonly unknown[]): number {
  return Math.max(items.length - LEVEL_MAX, 0)
}

function explored(symbol: GraphSymbol, center: string): ExploredSymbol {
  return {
    repo: symbol.repo ?? center,
    path: symbol.path,
    id: symbol.id,
    line: symbol.startLine,
    endLine: symbol.endLine,
    kind: symbol.kind,
    name: symbol.name,
    ...(symbol.owner === undefined ? {} : { owner: symbol.owner }),
    signature: symbol.signature,
    exported: symbol.exported,
  }
}

function graphSymbol(symbol: ExploredSymbol): GraphSymbol {
  return {
    path: symbol.path,
    id: symbol.id,
    kind: symbol.kind,
    name: symbol.name,
    ...(symbol.owner === undefined ? {} : { owner: symbol.owner }),
    startLine: symbol.line,
    endLine: symbol.endLine,
    exported: symbol.exported,
    signature: symbol.signature,
  }
}

function callerSite(site: Site, center: string): CallerSite {
  const repo = site.repo ?? center
  return {
    repo,
    path: site.path,
    line: site.line,
    ...(site.in === undefined ? {} : { in: explored(site.in, repo) }),
    kind: site.kind,
    how: site.how,
    ...(site.pullRequest === undefined ? {} : { pullRequest: site.pullRequest }),
  }
}

function dependencyEntry(item: Dependency, center: string): DependencyEntry {
  return {
    name: item.name,
    line: item.line,
    kind: item.kind,
    how: item.how,
    ...(item.target === undefined ? {} : { target: explored(item.target, item.repo ?? center) }),
    ...(item.module === undefined ? {} : { module: item.module }),
    ...(item.pullRequest === undefined ? {} : { pullRequest: item.pullRequest }),
  }
}
