import { toTerminalText } from '../app/terminal-text.js'
import type { Claim } from '../review/types.js'

const HEADING = '## Claims of the description\n\n'

export function formatClaimsSection(claims: readonly Claim[]): string {
  if (claims.length === 0) return `${HEADING}None.\n`
  return `${HEADING}${claims.map(claimLine).join('\n')}\n`
}

function claimLine({ claim, verdict, evidence }: Claim): string {
  const shown = oneLine(evidence)
  return `- ${verdict}: ${oneLine(claim)}${shown === '' ? '' : ` (${shown})`}`
}

function oneLine(text: string): string {
  return toTerminalText(text).replace(/\s+/g, ' ').trim()
}
