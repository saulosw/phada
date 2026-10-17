import type { DiffImpact, ImpactSite, ImpactedSymbol } from './types.js'

export const IMPACT_BUDGET_BYTES = 4_000

export function renderImpact(
  impact: DiffImpact,
  budget = IMPACT_BUDGET_BYTES,
): { text: string; shown: number[] } {
  const lines: string[] = []
  const shown: number[] = []
  let used = 0
  const fits = (line: string) => used + Buffer.byteLength(line) + 1 <= budget
  const add = (line: string) => {
    lines.push(line)
    used += Buffer.byteLength(line) + 1
  }
  let skipped = impact.omittedSymbols
  const reached = impact.symbols.map((symbol) => symbol.callers > 0 || symbol.capped === true)
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
      const reserve = symbol.callers - count - 1 > 0 ? Buffer.byteLength(more(count + 1)) + 1 : 0
      if (used + Buffer.byteLength(line) + 1 + reserve > budget) break
      add(line)
      count += 1
    }
    shownBySymbol[index] = count
    if (symbol.callers > count && fits(more(count))) add(more(count))
    if (symbol.dependencies.length > 0) {
      const depends = `  depends on: ${symbol.dependencies
        .map(({ name, path, line, kind }) => `${name} → ${path}:${line} (${kind})`)
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
  return { text: lines.join('\n'), shown }
}

function header(symbol: ImpactedSymbol): string {
  const place = `${symbol.path}:${symbol.startLine}-${symbol.endLine}${symbol.exported ? ', exported' : ''}`
  const more = symbol.capped === true ? '+' : ''
  const reach =
    symbol.callers === 0 && symbol.capped !== true
      ? 'no callers or uses found'
      : `${symbol.callers}${more} caller${symbol.callers === 1 && more === '' ? '' : 's'} in ${symbol.files}${more} file${symbol.files === 1 && more === '' ? '' : 's'}${symbol.capped === true ? ' (search cut short: use the callers tool with path)' : ''}`
  return `${symbol.kind} ${symbol.name} (${place}) — ${reach}`
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
  return `  ${site.path}:${site.line}${owner}${kind}${tag}: ${site.text}`
}
