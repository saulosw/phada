import type { InvestigationCallReport, InvestigationReport } from '../investigation/tools/report.js'
import { toTerminalText } from './terminal-text.js'
import { formatBytes, formatCount } from './units.js'

const NOUNS: Readonly<Record<string, string>> = {
  read_file: 'read',
  grep: 'search',
  list: 'list',
}

export function formatInvestigationLine(report: InvestigationReport): string | undefined {
  if (report.status === 'off') return 'Investigation: off'
  if (report.status === 'unavailable') return undefined
  const external = externalPart(report)
  if (report.calls.length === 0 && external === '') return 'Investigated: no tool calls'
  const counts = new Map<string, number>()
  for (const call of report.calls) {
    const noun = NOUNS[call.tool] ?? 'call'
    counts.set(noun, (counts.get(noun) ?? 0) + 1)
  }
  const parts = [...counts].map(([noun, count]) =>
    formatCount(count, noun).replace(/searchs$/, 'searches'),
  )
  const calls =
    parts.length === 0
      ? 'no tool calls'
      : `${parts.join(', ')} (${formatBytes(report.totals.bytes)})`
  return `Investigated: ${calls}${external}`
}

export function formatInvestigationSection(report: InvestigationReport): string {
  const heading = '## Investigation\n\n'
  if (report.status === 'off') return `${heading}Off.\n`
  if (report.status === 'unavailable') {
    return `${heading}Not available${report.reason === undefined ? '' : `: ${toTerminalText(report.reason)}`}.\n`
  }
  const lines = [
    ...report.calls.map(callLine),
    ...report.external.map(
      ({ server, tool }) => `- MCP ${toTerminalText(server)}: ${toTerminalText(tool)}`,
    ),
  ]
  return `${heading}${lines.length === 0 ? 'No tool calls.' : lines.join('\n')}\n`
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
    pass === 'verify' ? '· verification' : '',
    inSources ? '· used in a finding' : '',
    error === null ? '' : `· error: ${toTerminalText(error)}`,
  ].filter((note) => note !== '')
  return `- ${toTerminalText(tool)} ${toTerminalText(target)} ${notes.join(' ')}`
}

function externalPart(report: InvestigationReport): string {
  if (report.external.length === 0) return ''
  const servers = [...new Set(report.external.map(({ server }) => toTerminalText(server)))]
  return ` · ${formatCount(report.external.length, 'MCP call')} (${servers.join(', ')})`
}
