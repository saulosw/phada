import type { ContextReport, DocReport, RuleReport } from '../context/types.js'
import { toTerminalText } from './terminal-text.js'
import { formatBytes, formatCount } from './units.js'

export function formatContextLine(report: ContextReport): string {
  const rules = report.rules.filter((rule) => rule.status === 'applied').length
  const docs = report.docs.filter((doc) => doc.status !== 'omitted').length
  const omitted = report.docs.length - docs
  const ignored = report.ignored.length
  if (rules === 0 && docs === 0 && omitted === 0 && ignored === 0) {
    return 'Context: no rules or docs'
  }
  const docDetails = [
    ...(docs > 0 ? [formatBytes(report.budget.used)] : []),
    ...(omitted > 0 ? [`${omitted} omitted`] : []),
  ]
  const parts = [
    formatCount(rules, 'rule'),
    `${formatCount(docs, 'doc')}${docDetails.length === 0 ? '' : ` (${docDetails.join(', ')})`}`,
    ...(ignored > 0 ? [`${formatCount(ignored, 'file')} ignored`] : []),
  ]
  return `Context: ${parts.join(' · ')}`
}

export function formatContextSection(report: ContextReport): string {
  const lists = [
    list('Rules', report.rules.map(ruleLine)),
    list('Docs', report.docs.map(docLine)),
    list('Ignored files', report.ignored.map(toTerminalText)),
  ].filter((section) => section !== '')
  const body = lists.length === 0 ? 'No rules or docs.\n' : lists.join('\n')
  return `## Context sent to the AI\n\n${body}`
}

function list(heading: string, items: readonly string[]): string {
  if (items.length === 0) return ''
  return `${heading}:\n${items.map((item) => `- ${item}`).join('\n')}\n`
}

function ruleLine({ key, origin, status }: RuleReport): string {
  const notes = [toTerminalText(origin)]
  if (status === 'disabled') notes.push('disabled')
  if (status === 'out-of-scope') notes.push('out of scope')
  return `${toTerminalText(key)} (${notes.join(', ')})`
}

function docLine({ path, bytes, status, reason }: DocReport): string {
  const notes = [formatBytes(bytes)]
  if (status === 'truncated') notes.push('truncated')
  if (status === 'omitted') notes.push(`omitted: ${reason ?? 'budget'}`)
  return `${toTerminalText(path)} (${notes.join(', ')})`
}
