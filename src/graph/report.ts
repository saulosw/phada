import type { DiffImpact } from '../review/types.js'
import type { ObservedEdge, ObservedEndpoint } from '../store/observed-store.js'

export type ImpactStatus = 'used' | 'unavailable' | 'off'

export interface ImpactIndex {
  files: number
  extracted: number
  durationMs: number
}

export interface ImpactReport {
  status: ImpactStatus
  reason?: string
  index?: ImpactIndex
  changed: {
    kind: string
    name: string
    path: string
    lines: [number, number]
    callers: number
    files: number
    shown: number
    dependencies: number
    capped: boolean
  }[]
  totals: { symbols: number; callers: number; files: number }
  learned: { from: string; to: string; pullRequest: number }[]
}

export interface ImpactReportInput {
  status: ImpactStatus
  reason?: string
  index?: ImpactIndex
  impact?: DiffImpact
  shown?: readonly number[]
  learned?: readonly ObservedEdge[]
}

export function buildImpactReport(input: ImpactReportInput): ImpactReport {
  const symbols = input.impact?.symbols ?? []
  return {
    status: input.status,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.index === undefined ? {} : { index: input.index }),
    changed: symbols.map((symbol, index) => ({
      kind: symbol.kind,
      name: symbol.name,
      path: symbol.path,
      lines: [symbol.startLine, symbol.endLine],
      callers: symbol.callers,
      files: symbol.files,
      shown: input.shown?.[index] ?? 0,
      dependencies: symbol.dependencies.length,
      capped: symbol.capped === true,
    })),
    totals: {
      symbols: symbols.length + (input.impact?.omittedSymbols ?? 0),
      callers: symbols.reduce((sum, symbol) => sum + symbol.callers, 0),
      files: input.impact?.callerFiles ?? 0,
    },
    learned: (input.learned ?? []).map((edge) => ({
      from: endpointLabel(edge.from),
      to: endpointLabel(edge.to),
      pullRequest: edge.pullRequest,
    })),
  }
}

function endpointLabel(point: ObservedEndpoint): string {
  if (point.name === undefined) return point.path
  return `${point.path} ${point.owner === undefined ? '' : `${point.owner}.`}${point.name}`
}
