import type { ExternalToolCall } from '../../providers/types.js'
import type { Finding } from '../../review/types.js'
import type { ReviewPass, ToolCallRecord, ToolLog } from './tool-log.js'

export type InvestigationStatus = 'used' | 'off' | 'unavailable'

export interface InvestigationCallReport {
  pass: ReviewPass
  tool: string
  server: string | null
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
  mcp?: McpServerReport[]
  totals: { calls: number; bytes: number }
}

export interface McpServerReport {
  server: string
  via: 'phada' | 'cli'
  status: 'connected' | 'failed' | 'off'
  tools: string[]
  hidden: string[]
  reason?: string
}

export interface InvestigationReportInput {
  status: InvestigationStatus
  reason?: string
  log?: ToolLog
  findings: readonly Finding[]
  external?: readonly ExternalToolCall[]
  mcp?: readonly McpServerReport[]
}

const LINE_SUFFIX = /:\d+(?:-\d+)?$/
const MAX_MCP_TARGET = 80

export function buildInvestigationReport(input: InvestigationReportInput): InvestigationReport {
  const cited = new Set(
    input.findings.flatMap((finding) =>
      (finding.sources ?? []).map((source) => source.replace(LINE_SUFFIX, '')),
    ),
  )
  const calls = (input.log?.records ?? []).map((record) => ({
    pass: record.pass,
    tool: record.tool,
    server: record.server ?? null,
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
    ...(input.mcp === undefined ? {} : { mcp: [...input.mcp] }),
    totals: {
      calls: calls.length,
      bytes: calls.reduce((sum, call) => sum + call.bytes, 0),
    },
  }
}

function targetOf({ tool, args, server }: ToolCallRecord): string {
  if (server !== undefined) {
    const text = JSON.stringify(args ?? {})
    return text.length <= MAX_MCP_TARGET ? text : `${text.slice(0, MAX_MCP_TARGET - 1)}…`
  }
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
  if (tool === 'history') {
    const from = numberArg(args, 'from')
    const to = numberArg(args, 'to')
    return from === undefined ? (path ?? '') : `${path ?? ''}:${from}-${to ?? from}`
  }
  const name = stringArg(args, 'name')
  if (name === undefined) return ''
  if (tool === 'find_symbol') {
    const kind = stringArg(args, 'kind')
    return kind === undefined ? name : `${name} (${kind})`
  }
  return path === undefined ? name : `${name} in ${path}`
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
