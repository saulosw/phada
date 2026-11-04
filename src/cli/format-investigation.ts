import type {
  InvestigationCallReport,
  InvestigationReport,
  McpServerReport,
} from '../investigation/tools/report.js'
import { toTerminalText } from '../app/terminal-text.js'
import { gapText } from '../review/coverage.js'
import type { Coverage } from '../review/types.js'
import { formatBytes, formatCount } from './units.js'

const NOUNS: Readonly<Record<string, string>> = {
  read_file: 'read',
  grep: 'search',
  list: 'list',
  find_symbol: 'graph query',
  callers: 'graph query',
  dependencies: 'graph query',
  similar: 'graph query',
  history: 'history lookup',
}
const MAX_HIDDEN_SHOWN = 5
const MAX_GAPS_SHOWN = 20

export function formatInvestigationLine(report: InvestigationReport): string | undefined {
  if (report.status === 'off') return 'Investigation: off'
  if (report.status === 'unavailable') return undefined
  const counts = new Map<string, number>()
  for (const call of report.calls) {
    if (call.server !== null) continue
    const noun = NOUNS[call.tool] ?? 'call'
    counts.set(noun, (counts.get(noun) ?? 0) + 1)
  }
  const parts = [...counts].map(([noun, count]) =>
    formatCount(count, noun)
      .replace(/searchs$/, 'searches')
      .replace(/querys$/, 'queries'),
  )
  const sections = [
    ...(parts.length === 0 ? [] : [`${parts.join(', ')} (${formatBytes(report.totals.bytes)})`]),
    ...mcpPart(report),
  ]
  return `Investigated: ${sections.length === 0 ? 'no tool calls' : sections.join(' · ')}`
}

export function formatInvestigationSection(
  report: InvestigationReport,
  coverage?: Coverage,
): string {
  const lines = coverage === undefined ? [] : coverageLines(coverage)
  const more = lines.length === 0 ? '' : `\n${lines.join('\n')}\n`
  return `## Investigation\n\n${investigationText(report)}\n${more}`
}

function investigationText(report: InvestigationReport): string {
  if (report.status === 'off') return 'Off.'
  if (report.status === 'unavailable') {
    return `Not available${report.reason === undefined ? '' : `: ${toTerminalText(report.reason)}`}.`
  }
  const lines = [
    ...report.calls.map(callLine),
    ...report.external.map(
      ({ server, tool }) => `- MCP ${toTerminalText(server)}: ${toTerminalText(tool)}`,
    ),
    ...(report.mcp ?? []).map(serverLine),
  ]
  return lines.length === 0 ? 'No tool calls.' : lines.join('\n')
}

function coverageLines(coverage: Coverage): string[] {
  const { level, covered, total, gaps, verified, reason, continuation } = coverage
  if (level === 'full') return []
  const before =
    continuation === undefined
      ? ''
      : `, after a continuation pass (was ${continuation.before.level}, ${continuation.before.covered} of ${continuation.before.total})`
  const name = verified ? 'Coverage' : 'Coverage (declared)'
  const hidden = gaps.length - MAX_GAPS_SHOWN
  return [
    `${name}: ${level}, ${covered} of ${formatCount(total, 'file')} — ${toTerminalText(reason)}${before}`,
    ...gaps
      .slice(0, MAX_GAPS_SHOWN)
      .map((gap) => `- ${toTerminalText(gap.path)}: ${toTerminalText(gapText(gap))}`),
    ...(hidden > 0 ? [`- … (+${hidden} more)`] : []),
  ]
}

function callLine({
  pass,
  tool,
  target,
  bytes,
  error,
  inSources,
}: InvestigationCallReport): string {
  const notes = [
    error === null ? `(${formatBytes(bytes)})` : '',
    pass === 'verify' ? '· verification' : pass === 'recheck' ? '· recheck' : '',
    inSources ? '· used in a finding' : '',
    error === null ? '' : `· error: ${toTerminalText(error)}`,
  ].filter((note) => note !== '')
  return `- ${toTerminalText(tool)} ${toTerminalText(target)} ${notes.join(' ')}`
}

function mcpPart(report: InvestigationReport): string[] {
  const servers = [
    ...report.calls.flatMap(({ server }) => (server === null ? [] : [server])),
    ...report.external.map(({ server }) => server),
  ]
  if (servers.length === 0) return []
  const names = [...new Set(servers.map(toTerminalText))]
  return [`${formatCount(servers.length, 'MCP call')} (${names.join(', ')})`]
}

function serverLine({ server, via, status, tools, hidden, reason }: McpServerReport): string {
  const name = `- MCP ${toTerminalText(server)}${via === 'cli' ? ' (AI CLI)' : ''}`
  if (status === 'off') return `${name}: off (outside author)`
  if (status === 'failed') return `${name}: failed: ${toTerminalText(reason ?? '')}`
  if (via === 'cli') {
    return tools.length === 0
      ? `${name}: connected`
      : `${name}: connected, tools ${tools.join(', ')}`
  }
  const shown = hidden.slice(0, MAX_HIDDEN_SHOWN).map(toTerminalText)
  const more = hidden.length > MAX_HIDDEN_SHOWN ? ', …' : ''
  const hiddenText =
    hidden.length === 0 ? '' : ` (${hidden.length} hidden: ${shown.join(', ')}${more})`
  return `${name}: connected, ${formatCount(tools.length, 'tool')}${hiddenText}`
}
