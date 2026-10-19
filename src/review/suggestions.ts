import { findDiffFile } from './diff-lines.js'
import type { DiffFile } from './diff-lines.js'
import type { Finding, Suggestion } from './types.js'

export const MAX_SUGGESTION_LINES = 20

export function checkSuggestion(
  finding: Finding,
  files: readonly DiffFile[],
): Suggestion | undefined {
  const { suggestion } = finding
  if (suggestion === undefined) return undefined
  const { startLine, endLine } = suggestion
  if (startLine > endLine || endLine - startLine + 1 > MAX_SUGGESTION_LINES) return undefined
  if (finding.line < startLine || finding.line > endLine) return undefined
  const file = findDiffFile(finding.file, files)
  if (file === undefined) return undefined
  const texts: string[] = []
  const hunk = file.newText.get(startLine)?.hunk
  for (let number = startLine; number <= endLine; number++) {
    const line = file.newText.get(number)
    if (line === undefined || line.hunk !== hunk) return undefined
    texts.push(line.text)
  }
  const original = normalize(suggestion.original)
  if (original !== texts.join('\n')) return undefined
  if (normalize(suggestion.replacement) === original) return undefined
  return suggestion
}

export function normalize(code: string): string {
  return code.replace(/\r/g, '').replace(/\n$/, '')
}
