import { toTerminalText } from '../app/terminal-text.js'
import { CLOSE_TO_CUT_MARGIN } from '../review/select-findings.js'

export interface CutFinding {
  severity: string | null
  file: string
  line: number | null
  title: string
  confidence: number | null
  closeToCut?: boolean
}

const HEADING = '## Close to the cut\n\n'

export function formatCloseToCutSection(
  findings: readonly CutFinding[],
  minConfidence: number,
): string {
  const close = findings.filter(({ closeToCut }) => closeToCut === true)
  const margin = `at most ${CLOSE_TO_CUT_MARGIN} points above the cut of ${minConfidence}`
  if (close.length === 0) return `${HEADING}None: no finding is ${margin}.\n`
  return `${HEADING}${close.length} close to the cut: ${margin}, another run may leave them out.\n\n${close.map(findingLine).join('\n')}\n`
}

function findingLine({ severity, file, line, title, confidence }: CutFinding): string {
  const where = line === null ? oneLine(file) : `${oneLine(file)}:${line}`
  return `- ${oneLine(severity ?? '--')} · ${where}: ${oneLine(title)} (confidence ${confidence ?? '--'})`
}

function oneLine(text: string): string {
  return toTerminalText(text).replace(/\s+/g, ' ').trim()
}
