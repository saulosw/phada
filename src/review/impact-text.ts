import type { DiffImpact, ImpactSite, ImpactedSymbol } from './types.js'

export const IMPACT_BUDGET_BYTES = 8_000

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
  for (const [index, symbol] of impact.symbols.entries()) {
    const head = header(symbol)
    if (!fits(head)) {
      skipped += impact.symbols.length - index
      shown.push(...impact.symbols.slice(index).map(() => 0))
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
    shown.push(count)
    if (symbol.callers > count && fits(more(count))) add(more(count))
    if (symbol.dependencies.length > 0) {
      const depends = `  depends on: ${symbol.dependencies
        .map(({ name, path, line, kind }) => `${name} → ${path}:${line} (${kind})`)
        .join(', ')}`
      if (fits(depends)) add(depends)
    }
  }
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
  const reach =
    symbol.callers === 0
      ? 'no callers or uses found'
      : `${symbol.callers} caller${symbol.callers === 1 ? '' : 's'} in ${symbol.files} file${symbol.files === 1 ? '' : 's'}`
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
