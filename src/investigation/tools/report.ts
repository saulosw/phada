import type { ExternalToolCall } from '../../providers/types.js'
import type { Finding } from '../../review/types.js'
import type { ReviewPass, ToolCallRecord, ToolLog } from './tool-log.js'

export type InvestigationStatus = 'used' | 'off' | 'unavailable'

export interface InvestigationCallReport {
  pass: ReviewPass
  tool: string
  target: string
  bytes: number
  error: string | null
  inSources: boolean
}

export interface InvestigationReport {
  status: InvestigationStatus
  reason?: string
  calls: InvestigationCallReport[]
  external: ExternalToolCall[]
  totals: { calls: number; bytes: number }
}

export interface InvestigationReportInput {
  status: InvestigationStatus
  reason?: string
  log?: ToolLog
  findings: readonly Finding[]
  external?: readonly ExternalToolCall[]
}

const LINE_SUFFIX = /:\d+(?:-\d+)?$/

export function buildInvestigationReport(input: InvestigationReportInput): InvestigationReport {
  const cited = new Set(
    input.findings.flatMap((finding) =>
      (finding.sources ?? []).map((source) => source.replace(LINE_SUFFIX, '')),
    ),
  )
  const calls = (input.log?.records ?? []).map((record) => ({
    pass: record.pass,
    tool: record.tool,
    target: targetOf(record),
    bytes: record.bytes,
    error: record.error ?? null,
    inSources: record.paths.some((path) => cited.has(path)),
  }))
  return {
    status: input.status,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    calls,
    external: [...(input.external ?? [])],
    totals: {
      calls: calls.length,
      bytes: calls.reduce((sum, call) => sum + call.bytes, 0),
    },
  }
}

function targetOf({ tool, args }: ToolCallRecord): string {
  const path = stringArg(args, 'path')
  if (tool === 'read_file') {
    const from = numberArg(args, 'from')
    const to = numberArg(args, 'to')
    const range = from === undefined && to === undefined ? '' : `:${from ?? 1}-${to ?? ''}`
    return `${path ?? ''}${range}`
  }
  if (tool === 'grep') {
    const pattern = stringArg(args, 'pattern') ?? ''
    return path === undefined || path === '' ? pattern : `${pattern} in ${path}`
  }
  if (tool === 'list') return path === undefined || path === '' ? '.' : path
  return ''
}

function stringArg(args: unknown, key: string): string | undefined {
  const value =
    typeof args === 'object' && args !== null ? (args as Record<string, unknown>)[key] : undefined
  return typeof value === 'string' ? value : undefined
}

function numberArg(args: unknown, key: string): number | undefined {
  const value =
    typeof args === 'object' && args !== null ? (args as Record<string, unknown>)[key] : undefined
  return typeof value === 'number' ? value : undefined
}
