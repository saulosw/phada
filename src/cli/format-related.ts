import type { RelatedEntry, RelatedReport } from '../app/related-report.js'
import { MAX_RELATED } from '../app/select-related.js'
import type { SkipReason } from '../app/select-related.js'
import { toTerminalText } from './terminal-text.js'
import { formatCount } from './units.js'

const SKIP_TEXT: Readonly<Record<SkipReason, string>> = {
  'reviewed-repository': 'the reviewed repository',
  'no-access': 'no access',
  empty: 'empty',
  'private-on-public': 'private, PR is public',
  'fetch-failed': 'fetch failed',
  limit: `over the limit of ${MAX_RELATED}`,
}

export function formatRelatedLine(report: RelatedReport): string | undefined {
  if (report.status === 'none') return undefined
  if (report.status !== 'used') return `Related: ${statusText(report)}`
  const entries = report.repositories.map((entry) =>
    entry.state === 'skipped'
      ? `${name(entry)} skipped (${skipText(entry)})`
      : `${name(entry)} (${stateText(entry)})`,
  )
  return `Related: ${entries.length === 0 ? 'none' : entries.join(' · ')}`
}

export function formatRelatedSection(report: RelatedReport): string {
  const heading = '## Related repositories\n\n'
  if (report.status === 'none') return `${heading}None declared.\n`
  if (report.status !== 'used') return `${heading}${statusText(report)}.\n`
  const lines = report.repositories.map((entry) => {
    const from = `(from ${toTerminalText(entry.origin)})`
    if (entry.state === 'skipped') return `- ${name(entry)} ${from}: skipped, ${skipText(entry)}`
    const parts = [stateText(entry)]
    if (entry.packages.length > 0)
      parts.push(`packages: ${entry.packages.map(toTerminalText).join(', ')}`)
    if (entry.description !== undefined) parts.push(`"${toTerminalText(entry.description)}"`)
    return `- ${name(entry)} at ${(entry.commit ?? '').slice(0, 7)} ${from}: ${parts.join(' · ')}`
  })
  return `${heading}${lines.join('\n')}\n`
}

function statusText(report: RelatedReport): string {
  if (report.status === 'off') return 'off (investigation disabled)'
  return `unavailable${report.reason === undefined ? '' : ` (${toTerminalText(report.reason)})`}`
}

function name(entry: RelatedEntry): string {
  return toTerminalText(entry.repo)
}

function skipText(entry: RelatedEntry): string {
  return entry.reason === undefined ? 'skipped' : SKIP_TEXT[entry.reason]
}

function stateText(entry: RelatedEntry): string {
  const count = entry.count ?? 0
  switch (entry.state) {
    case 'consumers':
      return `consumer, ${formatCount(count, 'call site')}`
    case 'uses':
      return `publisher, ${formatCount(count, 'symbol')} used`
    case 'linked':
      return entry.graph ? 'linked' : 'linked, read tools only'
    default:
      return 'no link'
  }
}
