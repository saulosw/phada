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

function codeSpan(text: string): string {
  return `\`${text.replace(/[`\r\n]/g, '')}\``
}
