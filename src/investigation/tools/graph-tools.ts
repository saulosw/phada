import { z } from 'zod'
import type {
  CallersResult,
  Dependency,
  GraphSymbol,
  RepositoryGraph,
  Site,
  Targets,
} from '../../graph/types.js'
import { qualified, RELATED_NOTE, withRepo } from './related-repo.js'
import type { RelatedCheckout } from './related-repo.js'
import { inputSchemaOf, ToolFailure } from './tool-registry.js'
import type { RegisteredTool, ToolOutput } from './tool-registry.js'

export const FIND_SYMBOL_MAX = 20
export const CALLERS_MAX_SITES = 60
export const DEPENDENCIES_MAX = 60
export const QUERY_TIME_LIMIT_MS = 5_000
export const LINE_TEXT_MAX_CHARS = 200

const KINDS = [
  'function',
  'method',
  'class',
  'struct',
  'interface',
  'type',
  'enum',
  'variable',
] as const

const FindSymbolArgs = z.strictObject({
  name: z.string().min(1).describe('Exact name of the function, class, method, type or variable'),
  kind: z.enum(KINDS).optional(),
})

const SymbolArgs = z.strictObject({
  name: z.string().min(1).describe('Name of the symbol'),
  path: z
    .string()
    .optional()
    .describe('File that defines it, to choose between symbols with the same name'),
})

export interface GraphToolsOptions {
  now?: () => number
  related?: readonly Pick<RelatedCheckout, 'repo' | 'graph'>[]
}

type WithRepo<T> = T & { repo?: string }

export function graphTools(
  graph: RepositoryGraph,
  options: GraphToolsOptions = {},
): RegisteredTool<any>[] {
  const now = options.now ?? (() => performance.now())
  const related = options.related ?? []
  const repos = related.map((item) => item.repo)
  const note = repos.length === 0 ? '' : RELATED_NOTE
  const findArgs = withRepo(FindSymbolArgs, repos) as z.ZodType<
    WithRepo<z.infer<typeof FindSymbolArgs>>
  >
  const symbolArgs = withRepo(SymbolArgs, repos) as z.ZodType<WithRepo<z.infer<typeof SymbolArgs>>>
  const graphOf = (repo: string | undefined): RepositoryGraph => {
    if (repo === undefined) return graph
    const found = related.find((item) => item.repo === repo)?.graph
    if (found === undefined) {
      throw new ToolFailure(
        'no-graph',
        `${repo} has no graph in this review: use read_file and grep with repo.`,
      )
    }
    return found
  }
  const timed = <T>(query: () => T): T => {
    const started = now()
    const result = query()
    if (now() - started > QUERY_TIME_LIMIT_MS) {
      throw new ToolFailure('too-slow', 'The query took too long: narrow it with path')
    }
    return result
  }

  const findSymbol: RegisteredTool<WithRepo<z.infer<typeof FindSymbolArgs>>> = {
    definition: {
      name: 'find_symbol',
      description: `Find where a function, class, method, type or variable is defined at the pull request head. Returns up to ${FIND_SYMBOL_MAX} definitions with their lines and signature.${note}`,
      inputSchema: inputSchemaOf(findArgs),
    },
    args: findArgs,
    run: async ({ name, kind, repo }) => {
      const found = timed(() => graphOf(repo).findSymbol(name, kind))
      if (found.length === 0) return noSymbol(name)
      const lines = found.slice(0, FIND_SYMBOL_MAX).map((symbol) => definitionLine(symbol, repo))
      if (found.length > FIND_SYMBOL_MAX) lines.push(`+${found.length - FIND_SYMBOL_MAX} more`)
      return {
        text: lines.join('\n'),
        paths: unique(found.map((symbol) => place(symbol, repo))),
        touched: [],
      }
    },
  }

  const callers: RegisteredTool<WithRepo<z.infer<typeof SymbolArgs>>> = {
    definition: {
      name: 'callers',
      description: `List the code that calls, uses or inherits from a symbol at the pull request head, with the text of each line. Returns up to ${CALLERS_MAX_SITES} lines.${note}`,
      inputSchema: inputSchemaOf(symbolArgs),
    },
    args: symbolArgs,
    run: async ({ repo, ...args }) => {
      const queried = graphOf(repo)
      const result = timed(() => queried.callers(args))
      if (result.symbols.length === 0) return noSymbol(args.name)
      return callersText(queried, args.name, result, repo)
    },
  }

  const dependencies: RegisteredTool<WithRepo<z.infer<typeof SymbolArgs>>> = {
    definition: {
      name: 'dependencies',
      description: `List what a symbol calls, uses and inherits, and where each of those is defined (or the package it comes from).${note}`,
      inputSchema: inputSchemaOf(symbolArgs),
    },
    args: symbolArgs,
    run: async ({ repo, ...args }) => {
      const result = timed(() => graphOf(repo).dependencies(args))
      if (result.symbols.length === 0) return noSymbol(args.name)
      const lines: string[] = []
      const paths: string[] = []
      for (const symbol of result.symbols) {
        lines.push(`What ${label(symbol, repo)} depends on:`)
        const own = result.dependencies.filter(
          (item) => item.line >= symbol.startLine && item.line <= symbol.endLine,
        )
        if (own.length === 0) lines.push('  nothing it calls or uses was found')
        for (const item of own.slice(0, DEPENDENCIES_MAX)) {
          lines.push(`  ${dependencyLine(item, repo)}`)
          if (item.target !== undefined) paths.push(place(item.target, repo))
        }
        if (own.length > DEPENDENCIES_MAX) lines.push(`  +${own.length - DEPENDENCIES_MAX} more`)
      }
      lines.push(...othersNote(args.name, result))
      return { text: lines.join('\n'), paths: unique(paths), touched: [] }
    },
  }

  const similar: RegisteredTool<WithRepo<z.infer<typeof SymbolArgs>>> = {
    definition: {
      name: 'similar',
      description: `List functions or methods built like the given one (same calls, parameters and name), to check that a change follows the same pattern.${note}`,
      inputSchema: inputSchemaOf(symbolArgs),
    },
    args: symbolArgs,
    run: async ({ repo, ...args }) => {
      const result = timed(() => graphOf(repo).similar(args))
      if (result.symbols.length === 0) return noSymbol(args.name)
      const callable = result.symbols.filter(
        (symbol) => symbol.kind === 'function' || symbol.kind === 'method',
      )
      if (callable.length === 0) {
        return {
          text: `${args.name} is not a function: similar compares functions and methods only.`,
          paths: [],
          touched: [],
        }
      }
      const lines = [
        `Functions built like ${callable.map((symbol) => label(symbol, repo)).join(', ')}:`,
      ]
      if (result.similar.length === 0) lines.push('  No similar functions found.')
      for (const { symbol, score, shared } of result.similar) {
        const shares = shared.length === 0 ? '' : ` · shares: ${shared.join(', ')}`
        lines.push(
          `  ${symbol.kind} ${symbol.name} — ${place(symbol, repo)}:${symbol.startLine}-${symbol.endLine} · score ${score.toFixed(2)}${shares}`,
        )
      }
      lines.push(...othersNote(args.name, result))
      return {
        text: lines.join('\n'),
        paths: unique(result.similar.map(({ symbol }) => place(symbol, repo))),
        touched: [],
      }
    },
  }

  return [findSymbol, callers, dependencies, similar]
}

async function callersText(
  graph: RepositoryGraph,
  name: string,
  result: CallersResult,
  repo?: string,
): Promise<ToolOutput> {
  const lines: string[] = []
  const touched: string[] = []
  let shown = 0
  for (const symbol of result.symbols) {
    lines.push(`Callers and uses of ${label(symbol, repo)}:`)
    const sites = result.sites.filter((site) => reachesSymbol(site, symbol))
    if (sites.length === 0) lines.push('No callers or uses found in the indexed files.')
    let file: string | undefined
    for (const site of sites) {
      if (shown >= CALLERS_MAX_SITES) break
      const where = qualified(site.repo ?? repo, site.path)
      if (where !== file) {
        file = where
        lines.push(where)
        touched.push(where)
      }
      lines.push(`  ${await siteLine(graph, site)}`)
      shown += 1
    }
  }
  if (result.sites.length > shown) lines.push(`+${result.sites.length - shown} more callers`)
  lines.push(...othersNote(name, result))
  if (result.capped) {
    lines.push(
      `Too many call sites named ${name}: only the first ${result.sites.length} found were checked.`,
    )
  }
  return { text: lines.join('\n'), paths: unique(touched), touched: unique(touched) }
}

function reachesSymbol(site: Site, symbol: GraphSymbol): boolean {
  return site.target.path === symbol.path && site.target.id === symbol.id
}

export async function siteLine(graph: RepositoryGraph, site: Site): Promise<string> {
  const text = ((await graph.lineText(site.path, site.line, site.repo)) ?? '')
    .trim()
    .slice(0, LINE_TEXT_MAX_CHARS)
  const kind = site.kind === 'calls' ? '' : ` (${site.kind})`
  return `${site.line}${site.in === undefined ? '' : ` in ${site.in.name}`}${kind}${tagOf(site)}: ${text}`
}

export function tagOf(site: { how: string; pullRequest?: number }): string {
  if (site.how === 'inferred') return ' [inferred]'
  if (site.how === 'observed')
    return ` [observed${site.pullRequest === undefined ? '' : ` #${site.pullRequest}`}]`
  return ''
}

function place(symbol: GraphSymbol, repo?: string): string {
  return qualified(symbol.repo ?? repo, symbol.path)
}

function dependencyLine(item: Dependency, repo?: string): string {
  const where =
    item.target === undefined
      ? item.how === 'observed'
        ? `${item.module ?? ''} (file)`
        : `external${item.module === undefined ? '' : ` (${item.module})`}`
      : `${place(item.target, repo)}:${item.target.startLine} ${item.target.kind} ${item.target.name}`
  return `${item.name} (${item.kind}, line ${item.line}) → ${where}${tagOf(item)}`
}

function definitionLine(symbol: GraphSymbol, repo?: string): string {
  const owner = symbol.owner === undefined ? '' : `${symbol.owner}.`
  return `${symbol.kind} ${owner}${symbol.name} — ${place(symbol, repo)}:${symbol.startLine}-${symbol.endLine}${symbol.exported ? ' [exported]' : ''} · ${symbol.signature}`
}

function label(symbol: GraphSymbol, repo?: string): string {
  const owner = symbol.owner === undefined ? '' : `${symbol.owner}.`
  return `${symbol.kind} ${owner}${symbol.name} (${place(symbol, repo)}:${symbol.startLine}-${symbol.endLine})`
}

function othersNote(name: string, targets: Targets): string[] {
  if (targets.others === 0) return []
  const total = targets.symbols.length + targets.others
  return [
    `Showing the first ${targets.symbols.length} of ${total} definitions named ${name}; pass path to choose.`,
  ]
}

function noSymbol(name: string): ToolOutput {
  return { text: `No symbol named ${name} in the indexed files.`, paths: [], touched: [] }
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)]
}
