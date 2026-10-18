import type { Language } from '../repo-map/languages.js'
import type { SymbolKind } from '../repo-map/types.js'
import { INFERRED_MAX_DEFINITIONS } from './resolve-name.js'
import { sortSites } from './repository-graph.js'
import type { PackageRef } from './packages.js'
import type { RepositoryLink } from './repository-links.js'
import type {
  CallersResult,
  DependenciesResult,
  Dependency,
  ExternalSite,
  GraphSymbol,
  RepositoryGraph,
  SimilarResult,
  Site,
  SymbolTarget,
  Targets,
} from './types.js'

export interface LinkedRepository {
  repo: string
  graph: RepositoryGraph
  link: RepositoryLink
}

const SCRIPT_LANGUAGES: ReadonlySet<Language> = new Set(['typescript', 'tsx', 'javascript'])

export function linkGraphs(
  reviewed: RepositoryGraph,
  related: readonly LinkedRepository[],
): RepositoryGraph {
  return related.length === 0 ? reviewed : new LinkedGraph(reviewed, related)
}

export function matchesPackage(
  ref: PackageRef,
  module: string,
  language: Language | undefined,
  publisher: RepositoryGraph,
): boolean {
  if (language === undefined) return false
  if (ref.ecosystem === 'python') {
    return language === 'python' && publisher.resolvesPackage(module, 'python')
  }
  const family = ref.ecosystem === 'go' ? language === 'go' : SCRIPT_LANGUAGES.has(language)
  return family && (module === ref.name || module.startsWith(`${ref.name}/`))
}

class LinkedGraph implements RepositoryGraph {
  readonly commit: string
  readonly #reviewed: RepositoryGraph
  readonly #related: readonly LinkedRepository[]

  constructor(reviewed: RepositoryGraph, related: readonly LinkedRepository[]) {
    this.commit = reviewed.commit
    this.#reviewed = reviewed
    this.#related = related
  }

  findSymbol(name: string, kind?: SymbolKind): GraphSymbol[] {
    return this.#reviewed.findSymbol(name, kind)
  }

  targets(target: SymbolTarget | GraphSymbol): Targets {
    return this.#reviewed.targets(target)
  }

  callers(target: SymbolTarget | GraphSymbol): CallersResult {
    const found = this.#reviewed.callers(target)
    const crossing: Site[] = []
    for (const symbol of found.symbols) {
      for (const consumer of this.#related) {
        if (consumer.link.consumedByRelated.length === 0) continue
        crossing.push(...this.#consumerSites(symbol, consumer))
      }
    }
    return { ...found, sites: sortSites([...found.sites, ...crossing]) }
  }

  dependencies(target: SymbolTarget | GraphSymbol): DependenciesResult {
    const found = this.#reviewed.dependencies(target)
    const language = found.symbols[0] && this.#reviewed.languageOf(found.symbols[0].path)
    const dependencies = found.dependencies.flatMap((item): Dependency[] => {
      if (item.target !== undefined || item.module === undefined) return [item]
      for (const publisher of this.#related) {
        const accepted = publisher.link.consumedByReviewed.some((ref) =>
          matchesPackage(ref, item.module ?? '', language, publisher.graph),
        )
        if (!accepted || language === undefined) continue
        const targets = definitionsIn(publisher.graph, item, language)
        if (targets.length === 0) continue
        return targets.map((symbol) => ({
          ...item,
          repo: publisher.repo,
          target: { ...symbol, repo: publisher.repo },
        }))
      }
      return [item]
    })
    return { ...found, dependencies }
  }

  similar(target: SymbolTarget | GraphSymbol): SimilarResult {
    return this.#reviewed.similar(target)
  }

  symbolAt(path: string, line: number): GraphSymbol | undefined {
    return this.#reviewed.symbolAt(path, line)
  }

  lineText(path: string, line: number, repo?: string): Promise<string | undefined> {
    if (repo === undefined) return this.#reviewed.lineText(path, line)
    const other = this.#related.find((item) => item.repo === repo)
    return other === undefined ? Promise.resolve(undefined) : other.graph.lineText(path, line)
  }

  exported(specifier: string, name: string, language: Language): GraphSymbol[] {
    return this.#reviewed.exported(specifier, name, language)
  }

  members(owner: GraphSymbol, name: string): GraphSymbol[] {
    return this.#reviewed.members(owner, name)
  }

  exportedMethods(name: string): GraphSymbol[] {
    return this.#reviewed.exportedMethods(name)
  }

  externalSites(name: string): ExternalSite[] {
    return this.#reviewed.externalSites(name)
  }

  importsModule(path: string, accepts: (module: string) => boolean): boolean {
    return this.#reviewed.importsModule(path, accepts)
  }

  languageOf(path: string): Language | undefined {
    return this.#reviewed.languageOf(path)
  }

  resolvesPackage(specifier: string, language: Language): boolean {
    return this.#reviewed.resolvesPackage(specifier, language)
  }

  #consumerSites(symbol: GraphSymbol, consumer: LinkedRepository): Site[] {
    const sites: Site[] = []
    const accepts = (module: string, language: Language | undefined) =>
      consumer.link.consumedByRelated.some((ref) =>
        matchesPackage(ref, module, language, this.#reviewed),
      )
    let guessable: boolean | undefined
    for (const site of consumer.graph.externalSites(symbol.name)) {
      const language = consumer.graph.languageOf(site.path)
      let how: Site['how'] | undefined
      if (site.module !== undefined) {
        if (!accepts(site.module, language) || language === undefined) continue
        const reached = definitionsIn(this.#reviewed, site, language).some(
          (found) => found.path === symbol.path && found.id === symbol.id,
        )
        if (reached) how = 'resolved'
      } else if (symbol.kind === 'method') {
        guessable ??= isGuessable(this.#reviewed.exportedMethods(symbol.name), symbol)
        if (
          guessable &&
          consumer.graph.importsModule(site.path, (module) => accepts(module, language))
        )
          how = 'inferred'
      }
      if (how === undefined) continue
      sites.push({
        repo: consumer.repo,
        path: site.path,
        line: site.line,
        target: symbol,
        ...(site.in === undefined ? {} : { in: { ...site.in, repo: consumer.repo } }),
        kind: site.kind,
        how,
      })
    }
    return sites
  }
}

function isGuessable(methods: readonly GraphSymbol[], symbol: GraphSymbol): boolean {
  return (
    methods.length > 0 &&
    methods.length <= INFERRED_MAX_DEFINITIONS &&
    methods.some((method) => method.path === symbol.path && method.id === symbol.id)
  )
}

function definitionsIn(
  publisher: RepositoryGraph,
  site: { name: string; module?: string; imported?: string; member?: string },
  language: Language,
): GraphSymbol[] {
  const module = site.module ?? ''
  const imported = site.imported ?? site.name
  if (site.member === undefined) return publisher.exported(module, imported, language)
  const owners = publisher.exported(module, imported, language)
  const members = owners.flatMap((owner) => publisher.members(owner, site.member ?? ''))
  if (members.length > 0 || language !== 'python') return members
  return publisher.exported(`${module}.${imported}`, site.member, language)
}
