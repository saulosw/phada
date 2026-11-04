import type { DiffImpact, ImpactCode, ImpactSimilar, ImpactSite, ImpactedSymbol } from './types.js'

export const IMPACT_BUDGET_BYTES = 4_000
export const IMPACT_SIMILAR_BYTES = 1_000
const SIMILAR_HEADING = 'Similar existing code (compare before you report a reimplementation):'

export function reachesOutside(symbol: ImpactedSymbol): boolean {
  return (
    symbol.callers > 0 ||
    symbol.capped === true ||
    symbol.dependencies.some((dependency) => dependency.repo !== undefined)
  )
}

export function renderImpact(
  impact: DiffImpact,
  total = IMPACT_BUDGET_BYTES,
): { text: string; shown: number[] } {
  const lines: string[] = []
  const shown: number[] = []
  let used = 0
  const similar = similarBlocks(impact.similar ?? [])
  const reserved =
    similar.length === 0
      ? 0
      : Math.min(IMPACT_SIMILAR_BYTES, bytesOf([SIMILAR_HEADING, ...similar.flat()]))
  let budget = total - reserved
  const fits = (line: string) => used + Buffer.byteLength(line) + 1 <= budget
  const add = (line: string) => {
    lines.push(line)
    used += Buffer.byteLength(line) + 1
  }
  let skipped = impact.omittedSymbols
  const reached = impact.symbols.map(reachesOutside)
  const shownBySymbol = impact.symbols.map(() => 0)
  const withCallers = impact.symbols.flatMap((symbol, index) => (reached[index] ? [index] : []))
  for (const [position, index] of withCallers.entries()) {
    const symbol = impact.symbols[index]
    if (symbol === undefined) continue
    const head = header(symbol)
    if (!fits(head)) {
      skipped += withCallers.length - position
      break
    }
    add(head)
    let count = 0
    const more = (shownSites: number) =>
      `  +${symbol.callers - shownSites} more: use the callers tool`
    for (const site of symbol.sites) {
      const line = siteLine(site)
      const uses = site.repeated?.uses ?? 1
      const reserve =
        symbol.callers - count - uses > 0 ? Buffer.byteLength(more(count + uses)) + 1 : 0
      if (used + Buffer.byteLength(line) + 1 + reserve > budget) break
      add(line)
      count += uses
    }
    shownBySymbol[index] = count
    if (symbol.callers > count && fits(more(count))) add(more(count))
    if (symbol.dependencies.length > 0) {
      const depends = `  depends on: ${symbol.dependencies
        .map(
          ({ name, repo, path, line, kind }) => `${name} → ${place(repo, path)}:${line} (${kind})`,
        )
        .join(', ')}`
      if (fits(depends)) add(depends)
    }
  }
  const lonely = impact.symbols.filter((_, index) => !reached[index])
  if (lonely.length > 0) {
    const names = lonely.map(
      (symbol) =>
        `${symbol.kind} ${symbol.name} (${symbol.path}:${symbol.startLine}-${symbol.endLine})`,
    )
    let line = `No callers or uses outside the diff: ${names.join(', ')}`
    while (!fits(line) && names.length > 1) {
      names.pop()
      line = `No callers or uses outside the diff: ${names.join(', ')}, +${lonely.length - names.length} more`
    }
    if (fits(line)) add(line)
  }
  shown.push(...shownBySymbol)
  if (skipped > 0) {
    const tail = `+${skipped} more changed symbols`
    while (lines.length > 0 && !fits(tail)) {
      const removed = lines.pop() ?? ''
      used -= Buffer.byteLength(removed) + 1
    }
    add(tail)
  }
  budget = total
  const fitsAll = (next: readonly string[]) => used + bytesOf(next) <= budget
  const [first] = similar
  if (first !== undefined && fitsAll([SIMILAR_HEADING, ...first.slice(0, 2)])) {
    add(SIMILAR_HEADING)
    for (const [head, ...likes] of similar) {
      if (head === undefined || !fitsAll([head, ...likes.slice(0, 1)])) break
      add(head)
      for (const like of likes) {
        if (!fits(like)) break
        add(like)
      }
    }
  }
  return { text: lines.join('\n'), shown }
}

function similarBlocks(similar: readonly ImpactSimilar[]): string[][] {
  return similar.map(({ symbol, like }) => [
    `${code(symbol)}:`,
    ...like.map(
      (item) =>
        `  ~ ${code(item)}${item.shared.length === 0 ? '' : `, shared calls: ${item.shared.join(', ')}`}`,
    ),
  ])
}

function code({ kind, name, path, startLine, endLine }: ImpactCode): string {
  return `${kind} ${name} (${path}:${startLine}-${endLine})`
}

function bytesOf(lines: readonly string[]): number {
  return lines.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0)
}

function header(symbol: ImpactedSymbol): string {
  const place = `${symbol.path}:${symbol.startLine}-${symbol.endLine}${symbol.exported ? ', exported' : ''}`
  const more = symbol.capped === true ? '+' : ''
  const reach =
    symbol.callers === 0 && symbol.capped !== true
      ? 'no callers or uses found'
      : `${symbol.callers}${more} caller${symbol.callers === 1 && more === '' ? '' : 's'} in ${symbol.files}${more} file${symbol.files === 1 && more === '' ? '' : 's'}${symbol.capped === true ? ' (search cut short: use the callers tool with path)' : ''}`
  const byName =
    symbol.unresolved === undefined || symbol.unresolved === 0
      ? ''
      : `, +${symbol.unresolved} matched by name only (unresolved, not listed)`
  return `${symbol.kind} ${symbol.name} (${place}) — ${reach}${byName}`
}

function siteLine(site: ImpactSite): string {
  const owner = site.in === undefined ? '' : ` in ${site.in}`
  const kind = site.kind === 'calls' ? '' : ` (${site.kind})`
  const tag =
    site.how === 'inferred'
      ? ' [inferred]'
      : site.how === 'observed'
        ? ` [observed${site.pullRequest === undefined ? '' : ` #${site.pullRequest}`}]`
        : ''
  if (site.repeated !== undefined) {
    const { uses, files, also } = site.repeated
    const places = [site, ...also].map((each) => `${place(each.repo, each.path)}:${each.line}`)
    const rest = uses - places.length
    return `  ${site.text}${tag} — ${uses} ${site.kind === 'calls' ? 'calls' : 'uses'} in ${files} files: ${places.join(', ')}${rest > 0 ? `, +${rest} more` : ''}`
  }
  return `  ${place(site.repo, site.path)}:${site.line}${owner}${kind}${tag}: ${site.text}`
}

function place(repo: string | undefined, path: string): string {
  return repo === undefined ? path : `${repo}:${path}`
}
