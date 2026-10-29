import type { CiBlock, CiCheckLine } from '../app/read-run-report.js'
import { CI_LOG_TOTAL_BYTES, CI_MAX_ANNOTATIONS } from '../context/ci.js'
import type { Ci } from '../context/types.js'
import { nameList } from './name-list.js'
import { toTerminalText } from '../app/terminal-text.js'
import { formatBytes, formatCount } from './units.js'

const HEADING = '## CI sent to the AI\n\n'
const LOG_BUDGET = `${CI_LOG_TOTAL_BYTES / 1024} KB`

export function formatCiLine({ summary }: Ci): string | undefined {
  if (summary.state === 'none') return undefined
  const { total, failing, pending } = summary
  const parts = [
    ...(failing.length > 0 ? [`${failing.length} failing (${checkNames(failing)})`] : []),
    ...(pending.length > 0 ? [`${pending.length} pending`] : []),
  ]
  return `CI: ${formatCount(total, 'check')}, ${parts.length === 0 ? 'all passing' : parts.join(', ')}`
}

export function checkNames(list: readonly string[]): string {
  return nameList(list, toTerminalText)
}

export function formatCiSection(ci: CiBlock | null): string {
  if (ci === null) return `${HEADING}Off.\n`
  const { annotations, logs } = ci
  const warnings = ci.warnings.map((warning) => `- ${toTerminalText(warning)}`)
  const tail = warnings.length === 0 ? '' : `Warnings:\n${warnings.join('\n')}\n`
  if (ci.checks.length === 0) return `${HEADING}No checks.\n${tail}`
  const leftOut = [
    ...(annotations.omitted > 0
      ? [`${formatCount(annotations.omitted, 'annotation')} over ${CI_MAX_ANNOTATIONS}`]
      : []),
    ...(logs.omitted > 0 ? [`${formatCount(logs.omitted, 'log')} over ${LOG_BUDGET}`] : []),
  ]
  const totals = [
    `Sent: ${formatBytes(ci.bytes)}, ${formatCount(annotations.sent, 'annotation')} of ${CI_MAX_ANNOTATIONS}, ${formatCount(logs.sent, 'log')} within ${LOG_BUDGET}`,
    ...(leftOut.length === 0 ? [] : [`Left out: ${leftOut.join(', ')}`]),
    ...(ci.truncated > 0
      ? [`Cut: ${formatCount(ci.truncated, 'text')} (a title, summary, annotation or log)`]
      : []),
  ]
  return `${HEADING}${ci.checks.map(checkLine).join('\n')}\n\n${totals.join('\n')}\n${tail}`
}

function checkLine(check: CiCheckLine): string {
  const notes = [
    ...(check.annotations === 0 ? [] : [formatCount(check.annotations, 'annotation')]),
    ...(check.logBytes === null ? [] : [`log ${formatBytes(check.logBytes)}`]),
  ]
  const conclusion =
    check.state === 'failing' && check.conclusion !== null
      ? ` (${toTerminalText(check.conclusion)})`
      : ''
  return `- ${toTerminalText(check.name)}: ${toTerminalText(check.state)}${conclusion}${notes.map((note) => `, ${note}`).join('')}`
}
