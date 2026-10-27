import type { ImpactReport } from '../graph/report.js'
import { toTerminalText } from '../app/terminal-text.js'
import { formatCount } from './units.js'

export function formatImpactLine(report: ImpactReport): string | undefined {
  if (report.status === 'off') return undefined
  if (report.status === 'unavailable') {
    return `Impact: unavailable${report.reason === undefined ? '' : ` (${toTerminalText(report.reason)})`}`
  }
  if (report.changed.length === 0) return 'Impact: no indexed symbols changed'
  const { symbols, callers, files } = report.totals
  return `Impact: ${formatCount(symbols, 'changed symbol')} · ${formatCount(callers, 'caller')} in ${formatCount(files, 'file')}`
}

export function formatImpactSection(report: ImpactReport, text: string | undefined): string {
  const heading = '## Impact\n\n'
  if (report.status === 'off') return `${heading}Off.\n`
  if (report.status === 'unavailable') {
    return `${heading}Not available${report.reason === undefined ? '' : `: ${toTerminalText(report.reason)}`}.\n`
  }
  if (report.changed.length === 0 || text === undefined)
    return `${heading}No indexed symbols changed.\n`
  const body = text
    .split('\n')
    .map((line) => toTerminalText(line))
    .join('\n')
  const learned = report.learned.map(
    ({ from, to, pullRequest }) =>
      `Learned: ${toTerminalText(from)} → ${toTerminalText(to)} (from #${pullRequest})`,
  )
  return `${heading}${body}\n${learned.length === 0 ? '' : `\n${learned.join('\n')}\n`}`
}
