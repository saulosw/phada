import { toTerminalText } from '../app/terminal-text.js'

export interface ClaimLine {
  claim: string
  verdict: string
  evidence: string | null
}

const HEADING = '## Claims of the description\n\n'

export function formatClaimsSection(claims: readonly ClaimLine[]): string {
  if (claims.length === 0) return `${HEADING}None.\n`
  return `${HEADING}${claims.map(claimLine).join('\n')}\n`
}

function claimLine({ claim, verdict, evidence }: ClaimLine): string {
  const shown = oneLine(evidence ?? '')
  return `- ${oneLine(verdict)}: ${oneLine(claim)}${shown === '' ? '' : ` (${shown})`}`
}

function oneLine(text: string): string {
  return toTerminalText(text).replace(/\s+/g, ' ').trim()
}
