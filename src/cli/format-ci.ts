import { CI_LOG_TOTAL_BYTES, CI_MAX_ANNOTATIONS } from '../publish/ci.js'
import type { Ci } from '../publish/types.js'
import type { CiCheck } from '../review/types.js'
import { toTerminalText } from './terminal-text.js'
import { formatBytes, formatCount } from './units.js'

const MAX_NAMES = 5
const HEADING = '## CI sent to the AI\n\n'
const LOG_BUDGET = `${CI_LOG_TOTAL_BYTES / 1024} KB`

const encoder = new TextEncoder()

export function formatCiLine({ summary }: Ci): string | undefined {
  if (summary.state === 'none') return undefined
  const { total, failing, pending } = summary
  const parts = [
    ...(failing.length > 0 ? [`${failing.length} failing (${names(failing)})`] : []),
    ...(pending.length > 0 ? [`${pending.length} pending`] : []),
  ]
  return `CI: ${formatCount(total, 'check')}, ${parts.length === 0 ? 'all passing' : parts.join(', ')}`
}

function names(list: readonly string[]): string {
  const shown = list.slice(0, MAX_NAMES).map(toTerminalText)
  const more = list.length - shown.length
  return [...shown, ...(more > 0 ? [`${more} more`] : [])].join(', ')
}

export function formatCiSection(ci: Ci | undefined): string {
  if (ci === undefined) return `${HEADING}Off.\n`
  const { report } = ci
  const warnings = (ci.warnings ?? []).map((warning) => `- ${toTerminalText(warning)}`)
  const tail = warnings.length === 0 ? '' : `Warnings:\n${warnings.join('\n')}\n`
  if (ci.checks.length === 0) return `${HEADING}No checks.\n${tail}`
  const leftOut = [
    ...(report.omittedAnnotations > 0
      ? [`${formatCount(report.omittedAnnotations, 'annotation')} over ${CI_MAX_ANNOTATIONS}`]
      : []),
    ...(report.omittedLogs > 0
      ? [`${formatCount(report.omittedLogs, 'log')} over ${LOG_BUDGET}`]
      : []),
  ]
  const totals = [
    `Sent: ${formatBytes(report.bytes)}, ${formatCount(report.annotations, 'annotation')} of ${CI_MAX_ANNOTATIONS}, ${formatCount(report.logs, 'log')} within ${LOG_BUDGET}`,
    ...(leftOut.length === 0 ? [] : [`Left out: ${leftOut.join(', ')}`]),
    ...(report.truncated > 0
      ? [`Cut: ${formatCount(report.truncated, 'text')} (a title, summary, annotation or log)`]
      : []),
  ]
  return `${HEADING}${ci.checks.map(checkLine).join('\n')}\n\n${totals.join('\n')}\n${tail}`
}

function checkLine(check: CiCheck): string {
  const notes = [
    ...(check.annotations === undefined
      ? []
      : [formatCount(check.annotations.length, 'annotation')]),
    ...(check.log === undefined ? [] : [`log ${formatBytes(encoder.encode(check.log).length)}`]),
  ]
  const conclusion =
    check.state === 'failing' && check.conclusion !== undefined
      ? ` (${toTerminalText(check.conclusion)})`
      : ''
  return `- ${toTerminalText(check.name)}: ${check.state}${conclusion}${notes.map((note) => `, ${note}`).join('')}`
}
