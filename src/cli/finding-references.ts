import type { Finding } from '../review/types.js'
import type { Messages } from './i18n/messages.js'

const LOCAL_PREFIX = 'local:'

export function findingReferences(
  finding: Finding,
  messages: Messages,
  { withLocalFiles = true }: { withLocalFiles?: boolean } = {},
): string {
  const sources = (finding.sources ?? []).filter(
    (source) => withLocalFiles || !source.startsWith(LOCAL_PREFIX),
  )
  const references = [
    ...sources.map(codeSpan),
    ...(finding.rule === undefined ? [] : [`${messages.rule} ${codeSpan(finding.rule)}`]),
  ]
  return references.length === 0 ? '' : `${messages.basedOn}: ${references.join(' · ')}`
}

const MAX_LEFT_OUT = 10

export function leftOutLine(files: readonly string[], messages: Messages): string {
  if (files.length === 0) return ''
  const shown = files.slice(0, MAX_LEFT_OUT).map(codeSpan)
  if (files.length > MAX_LEFT_OUT) shown.push(messages.moreItems(files.length - MAX_LEFT_OUT))
  return `${messages.leftOut}: ${shown.join(' · ')}`
}

function codeSpan(text: string): string {
  return `\`${text.replace(/[`\r\n]/g, '')}\``
}
