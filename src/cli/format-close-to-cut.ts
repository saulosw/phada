import { toTerminalText } from '../app/terminal-text.js'
import { CLOSE_TO_CUT_MARGIN } from '../review/select-findings.js'
import type { Finding } from '../review/types.js'

const HEADING = '## Close to the cut\n\n'

export function formatCloseToCutSection(
  findings: readonly Finding[],
  minConfidence: number,
): string {
  const close = findings.filter(({ closeToCut }) => closeToCut === true)
  const margin = `at most ${CLOSE_TO_CUT_MARGIN} points above the cut of ${minConfidence}`
  if (close.length === 0) return `${HEADING}None: no finding is ${margin}.\n`
  return `${HEADING}${close.length} close to the cut: ${margin}, another run may leave them out.\n\n${close.map(findingLine).join('\n')}\n`
}

function findingLine({ severity, file, line, title, confidence }: Finding): string {
  return `- ${severity} · ${oneLine(file)}:${line}: ${oneLine(title)} (confidence ${confidence})`
}

function oneLine(text: string): string {
  return toTerminalText(text).replace(/\s+/g, ' ').trim()
}
