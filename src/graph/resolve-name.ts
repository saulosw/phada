import { posix } from 'node:path'
import type { Language } from '../repo-map/languages.js'
import type { SymbolKind } from '../repo-map/types.js'
import type { ExportRow, ImportRow, IndexReader, SymbolRow } from '../store/index-reader.js'
import { dirOf } from './project-config.js'
import type { ProjectConfig } from './project-config.js'
import { goPackageFiles, pythonFile, resolveModule } from './resolve-module.js'
import type { ModuleTarget } from './resolve-module.js'
import type { GraphSymbol } from './types.js'

export const INFERRED_MAX_DEFINITIONS = 3
const MAX_HOPS = 5
const MAX_PARENT_LEVELS = 3
const SELF = new Set(['this', 'self', 'cls'])
const CLASS_KINDS: ReadonlySet<SymbolKind> = new Set(['class', 'struct', 'interface'])
const CALLABLE_KINDS: ReadonlySet<SymbolKind> = new Set(['function', 'method'])

export interface NameSite {
  name: string
  qualifier?: string
  ownerId?: number
  line: number
}

export type Resolution =
  { how: 'resolved' | 'inferred'; symbols: GraphSymbol[] } | { how: 'external'; module?: string }

export interface FileContext {
  path: string
  blobId: number
  language: Language
  symbols: readonly SymbolRow[]
  byId: ReadonlyMap<number, SymbolRow>
  bindings: ReadonlyMap<string, ImportRow>
  namespaces: ReadonlyMap<string, ImportRow>
  starImports: readonly ImportRow[]
  exports: readonly ExportRow[]
}

type Found = GraphSymbol[] | { module: string } | undefined

export class NameResolver {
  readonly #reader: IndexReader
  readonly #config: ProjectConfig
  readonly #contexts = new Map<string, FileContext | undefined>()
  readonly #modules = new Map<string, ModuleTarget>()
  readonly #packages = new Map<string, string[]>()
  readonly #inferredByName = new Map<string, Resolution>()
  readonly #resolved = new Map<string, Resolution>()

  constructor(reader: IndexReader, config: ProjectConfig) {
    this.#reader = reader
    this.#config = config
  }

  context(path: string): FileContext | undefined {
    if (this.#contexts.has(path)) return this.#contexts.get(path)
    const file = this.#reader.files().get(path)
    let context: FileContext | undefined
    if (file !== undefined) {
      const symbols = this.#reader.symbolsOfBlob(file.blobId)
      const bindings = new Map<string, ImportRow>()
      const namespaces = new Map<string, ImportRow>()
      const starImports: ImportRow[] = []
      for (const item of this.#reader.importsOfBlob(file.blobId)) {
        const local = item.alias ?? item.name
        if (local === undefined) continue
        if (local === '*') starImports.push(item)
        else if (item.kind === 'namespace') namespaces.set(local, item)
        else if (item.kind !== 'side-effect') {
          bindings.set(local, item)
          if (item.kind === 'require') namespaces.set(local, item)
        }
      }
      context = {
        path,
        blobId: file.blobId,
        language: file.language,
        symbols,
        byId: new Map(symbols.map((symbol) => [symbol.id, symbol])),
        bindings,
        namespaces,
        starImports,
        exports: this.#reader.exportsOfBlob(file.blobId),
      }
    }
    this.#contexts.set(path, context)
    return context
  }

  graphSymbol(path: string, row: SymbolRow, context = this.context(path)): GraphSymbol {
    const parent = row.parentId === undefined ? undefined : context?.byId.get(row.parentId)
    const owner = parent?.name ?? row.container
    return {
      path,
      id: row.id,
      kind: row.kind,
      name: row.name,
      ...(owner === undefined ? {} : { owner }),
      startLine: row.startLine,
      endLine: row.endLine,
      exported: row.exported,
      signature: row.signature,
    }
  }

  resolve(context: FileContext, site: NameSite): Resolution {
    const key = `${context.path}\0${site.ownerId ?? ''}\0${site.qualifier ?? ''}\0${site.name}`
    const known = this.#resolved.get(key)
    if (known !== undefined) return known
    const resolution = this.#resolveUncached(context, site)
    this.#resolved.set(key, resolution)
    return resolution
  }

  #resolveUncached(context: FileContext, site: NameSite): Resolution {
    const found =
      site.qualifier === undefined
        ? this.#unqualified(context, site, new Set())
        : this.#qualified(context, site)
    if (Array.isArray(found) && found.length > 0) return { how: 'resolved', symbols: found }
    if (found !== undefined && !Array.isArray(found))
      return { how: 'external', module: found.module }
    return this.#inferred(site.name)
  }

  #unqualified(context: FileContext, site: NameSite, visited: Set<string>): Found {
    const ancestors = this.#ancestors(context, site.ownerId)
    const local = context.symbols.filter(
      (symbol) =>
        symbol.name === site.name &&
        symbol.kind !== 'parameter' &&
        symbol.kind !== 'method' &&
        (symbol.parentId === undefined || ancestors.has(symbol.parentId)),
    )
    if (local.length > 0)
      return local.map((symbol) => this.graphSymbol(context.path, symbol, context))
    const binding = context.bindings.get(site.name)
    if (binding !== undefined) return this.#imported(context, binding, visited)
    if (context.language === 'go') {
      const inPackage = this.#packageSymbols(context.path, site.name, false)
      if (inPackage.length > 0) return inPackage
    }
    for (const star of context.starImports) {
      const target = this.#module(context.path, star.module, context.language)
      if (target.kind !== 'files') continue
      const found = this.#exported(target.paths, site.name, 0, visited)
      if (found.length > 0) return found
    }
    return undefined
  }

  #qualified(context: FileContext, site: NameSite): Found {
    const qualifier = site.qualifier ?? ''
    if (SELF.has(qualifier))
      return this.#member(context, this.#enclosingClass(context, site.ownerId), site.name)
    const namespace = context.namespaces.get(qualifier)
    if (namespace !== undefined) {
      const target = this.#module(context.path, namespace.module, context.language)
      if (target.kind === 'external') return { module: target.module }
      return this.#exported(target.paths, site.name, 0, new Set())
    }
    const binding = context.bindings.get(qualifier)
    if (binding !== undefined) {
      if (context.language === 'python') {
        const submodule = this.#pythonSubmodule(context, binding)
        if (submodule !== undefined) return this.#exported(submodule, site.name, 0, new Set())
      }
      const imported = this.#imported(context, binding, new Set())
      if (!Array.isArray(imported)) return imported
      return imported.flatMap((owner) => this.#membersOf(owner, site.name, 0))
    }
    const localClass = context.symbols.find(
      (symbol) => symbol.name === qualifier && CLASS_KINDS.has(symbol.kind),
    )
    if (localClass !== undefined) {
      return this.#membersOf(this.graphSymbol(context.path, localClass, context), site.name, 0)
    }
    if (context.language === 'go') return this.#goReceiver(context, site)
    return undefined
  }

  #imported(context: FileContext, binding: ImportRow, visited: Set<string>): Found {
    const target = this.#module(context.path, binding.module, context.language)
    if (target.kind === 'external') return { module: target.module }
    const name =
      binding.kind === 'default' ? 'default' : binding.kind === 'require' ? undefined : binding.name
    if (name === undefined) return { module: binding.module }
    if (context.language === 'python') {
      const submodule = this.#pythonSubmodule(context, binding)
      if (submodule !== undefined) return { module: binding.module }
    }
    const found = this.#exported(target.paths, name, 0, visited)
    return found.length > 0 ? found : { module: binding.module }
  }

  #exported(
    paths: readonly string[],
    name: string,
    hops: number,
    visited: Set<string>,
  ): GraphSymbol[] {
    const found: GraphSymbol[] = []
    for (const path of paths) {
      const key = `${path}\0${name}`
      if (visited.has(key) || hops > MAX_HOPS) continue
      visited.add(key)
      const context = this.context(path)
      if (context === undefined) continue
      found.push(...this.#exportedFrom(context, name, hops, visited))
    }
    return found
  }

  #exportedFrom(
    context: FileContext,
    name: string,
    hops: number,
    visited: Set<string>,
  ): GraphSymbol[] {
    const topLevel = (wanted: string) =>
      context.symbols
        .filter(
          (symbol) =>
            symbol.parentId === undefined && symbol.name === wanted && symbol.kind !== 'parameter',
        )
        .map((symbol) => this.graphSymbol(context.path, symbol, context))
    if (context.language === 'go') return this.#packageSymbols(context.path, name, true)
    if (context.language === 'python') {
      const own = topLevel(name)
      if (own.length > 0) return own
      const binding = context.bindings.get(name)
      if (binding === undefined) return []
      const imported = this.#imported(context, binding, visited)
      return Array.isArray(imported) ? imported : []
    }
    for (const item of context.exports.filter((entry) => entry.name === name)) {
      if (item.module !== undefined) {
        const target = this.#module(context.path, item.module, context.language)
        if (target.kind === 'files') {
          const found = this.#exported(target.paths, item.local ?? name, hops + 1, visited)
          if (found.length > 0) return found
        }
        continue
      }
      const local = topLevel(item.local ?? name)
      if (local.length > 0) return local
      const binding = item.local === undefined ? undefined : context.bindings.get(item.local)
      if (binding !== undefined) {
        const imported = this.#imported(context, binding, visited)
        if (Array.isArray(imported)) return imported
      }
    }
    if (name !== 'default') {
      const declared = topLevel(name).filter((symbol) => symbol.exported)
      if (declared.length > 0) return declared
    }
    for (const item of context.exports.filter(
      (entry) => entry.name === '*' && entry.module !== undefined,
    )) {
      const target = this.#module(context.path, item.module ?? '', context.language)
      if (target.kind !== 'files') continue
      const found = this.#exported(target.paths, name, hops + 1, visited)
      if (found.length > 0) return found
    }
    return []
  }

  #member(context: FileContext, owner: SymbolRow | undefined, name: string): Found {
    if (owner === undefined) return undefined
    return this.#membersOf(this.graphSymbol(context.path, owner, context), name, 0)
  }

  #membersOf(owner: GraphSymbol, name: string, level: number): GraphSymbol[] {
    const context = this.context(owner.path)
    if (context === undefined || level > MAX_PARENT_LEVELS) return []
    const own = context.symbols
      .filter((symbol) => symbol.parentId === owner.id && symbol.name === name)
      .map((symbol) => this.graphSymbol(owner.path, symbol, context))
    if (own.length > 0) return own
    for (const parent of this.parentsOf(owner)) {
      const inherited = this.#membersOf(parent, name, level + 1)
      if (inherited.length > 0) return inherited
    }
    return []
  }

  parentsOf(owner: GraphSymbol): GraphSymbol[] {
    const context = this.context(owner.path)
    if (context === undefined) return []
    return this.#reader
      .heritageOfBlob(context.blobId)
      .filter((item) => item.symbolId === owner.id)
      .flatMap((item) => {
        const found = this.#unqualified(
          context,
          { name: item.name.replace(/^.*\./, ''), line: owner.startLine },
          new Set(),
        )
        return Array.isArray(found) ? found.filter((symbol) => CLASS_KINDS.has(symbol.kind)) : []
      })
  }

  resolveHeritage(context: FileContext, name: string, line: number): Resolution {
    const dot = name.lastIndexOf('.')
    const site: NameSite =
      dot === -1
        ? { name, line }
        : { name: name.slice(dot + 1), qualifier: name.slice(0, dot), line }
    return this.resolve(context, site)
  }

  #enclosingClass(context: FileContext, ownerId: number | undefined): SymbolRow | undefined {
    let current = ownerId === undefined ? undefined : context.byId.get(ownerId)
    while (current !== undefined) {
      if (CLASS_KINDS.has(current.kind)) return current
      current = current.parentId === undefined ? undefined : context.byId.get(current.parentId)
    }
    return undefined
  }

  #goReceiver(context: FileContext, site: NameSite): Found {
    const owner = site.ownerId === undefined ? undefined : context.byId.get(site.ownerId)
    if (owner?.kind !== 'method') return undefined
    const isParameter = context.symbols.some(
      (symbol) =>
        symbol.parentId === owner.id &&
        symbol.kind === 'parameter' &&
        symbol.name === site.qualifier,
    )
    if (!isParameter) return undefined
    const parent = owner.parentId === undefined ? undefined : context.byId.get(owner.parentId)
    const typeName = parent?.name ?? owner.container
    if (typeName === undefined) return undefined
    return this.#packageFiles(context.path).flatMap((path) => {
      const other = this.context(path)
      if (other === undefined) return []
      return other.symbols
        .filter((symbol) => {
          if (symbol.kind !== 'method' || symbol.name !== site.name) return false
          const symbolParent =
            symbol.parentId === undefined ? undefined : other.byId.get(symbol.parentId)
          return (symbolParent?.name ?? symbol.container) === typeName
        })
        .map((symbol) => this.graphSymbol(path, symbol, other))
    })
  }

  #packageSymbols(path: string, name: string, exportedOnly: boolean): GraphSymbol[] {
    return this.#packageFiles(path).flatMap((file) => {
      const context = this.context(file)
      if (context === undefined) return []
      return context.symbols
        .filter(
          (symbol) =>
            symbol.parentId === undefined &&
            symbol.container === undefined &&
            symbol.kind !== 'method' &&
            symbol.kind !== 'parameter' &&
            symbol.name === name &&
            (!exportedOnly || symbol.exported),
        )
        .map((symbol) => this.graphSymbol(file, symbol, context))
    })
  }

  #packageFiles(path: string): string[] {
    const folder = dirOf(path)
    let files = this.#packages.get(folder)
    if (files === undefined) {
      files = goPackageFiles(folder, new Set(this.#reader.files().keys()))
      if (path.endsWith('_test.go')) files = [...files, path]
      this.#packages.set(folder, files)
    }
    return files
  }

  #pythonSubmodule(context: FileContext, binding: ImportRow): string[] | undefined {
    if (binding.name === undefined || binding.kind !== 'named') return undefined
    const target = this.#module(context.path, binding.module, context.language)
    if (target.kind !== 'files') return undefined
    const [file = ''] = target.paths
    if (!file.endsWith('__init__.py')) return undefined
    return pythonFile(posix.join(dirOf(file), binding.name), this.#reader.paths(), false)
  }

  #module(importer: string, specifier: string, language: Language): ModuleTarget {
    const key = `${language}\0${language === 'go' ? '' : importer}\0${specifier}`
    let target = this.#modules.get(key)
    if (target === undefined) {
      target = resolveModule(importer, specifier, language, this.#reader.paths(), this.#config)
      this.#modules.set(key, target)
    }
    return target
  }

  #ancestors(context: FileContext, ownerId: number | undefined): Set<number> {
    const ids = new Set<number>()
    let current = ownerId === undefined ? undefined : context.byId.get(ownerId)
    while (current !== undefined) {
      ids.add(current.id)
      current = current.parentId === undefined ? undefined : context.byId.get(current.parentId)
    }
    return ids
  }

  #inferred(name: string): Resolution {
    let resolution = this.#inferredByName.get(name)
    if (resolution === undefined) {
      resolution = this.#inferredUncached(name)
      this.#inferredByName.set(name, resolution)
    }
    return resolution
  }

  #inferredUncached(name: string): Resolution {
    const definitions = this.#reader
      .symbolsNamed(name)
      .filter((symbol) => CALLABLE_KINDS.has(symbol.kind))
      .flatMap((symbol) =>
        this.#reader.pathsOfBlob(symbol.blobId).map((path) => this.graphSymbol(path, symbol)),
      )
    if (definitions.length === 0 || definitions.length > INFERRED_MAX_DEFINITIONS)
      return { how: 'external' }
    return { how: 'inferred', symbols: definitions }
  }
}
