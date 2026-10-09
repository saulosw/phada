import type { Finding } from '../review/types.js'
import type { Messages } from './i18n/messages.js'

export function findingReferences(finding: Finding, messages: Messages): string {
  const references = [
    ...(finding.sources ?? []).map(codeSpan),
    ...(finding.rule === undefined ? [] : [`${messages.rule} ${codeSpan(finding.rule)}`]),
  ]
  return references.length === 0 ? '' : `${messages.basedOn}: ${references.join(' · ')}`
}

function codeSpan(text: string): string {
  return `\`${text.replace(/[`\r\n]/g, '')}\``
}
