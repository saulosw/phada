import type { FileMap } from '../../src/repo-map/types.js'

export function symbolLines(map: FileMap): string[] {
  return map.symbols.map((symbol) => {
    const parent = symbol.parent === undefined ? undefined : map.symbols[symbol.parent]
    const owner = parent === undefined ? '' : ` < ${parent.name}`
    const container = symbol.container === undefined ? '' : ` < (${symbol.container})`
    return `${symbol.kind} ${symbol.name}${owner}${container}${symbol.exported ? ' exported' : ''}`
  })
}

export function callLines(map: FileMap): string[] {
  return map.calls.map((call) => {
    const on = call.qualifier === undefined ? '' : ` on ${call.qualifier}`
    const caller = call.caller === undefined ? '(module)' : (map.symbols[call.caller]?.name ?? '?')
    return `${call.name}${on}${call.constructs ? ' new' : ''} in ${caller}`
  })
}

export function heritageLines(map: FileMap): string[] {
  return map.heritage.map(
    (item) => `${map.symbols[item.symbol]?.name ?? '?'} ${item.relation} ${item.name}`,
  )
}

export function symbolNamed(map: FileMap, kind: string, name: string, nth = 0) {
  return map.symbols.filter((symbol) => symbol.kind === kind && symbol.name === name)[nth]
}
