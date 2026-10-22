import { findDiffFile } from './diff-lines.js'
import type { DiffFile } from './diff-lines.js'
import type { Finding, Suggestion, SuggestionCounts } from './types.js'

export const MAX_SUGGESTION_LINES = 20

const HIDDEN_CHARACTERS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]|\p{Cf}/u

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
  if (HIDDEN_CHARACTERS.test(suggestion.replacement)) return undefined
  return suggestion
}

export function normalize(code: string): string {
  return code.replace(/\r/g, '').replace(/\n$/, '')
}

export function checkSuggestions(
  findings: readonly Finding[],
  files: readonly DiffFile[],
): { findings: Finding[]; counts?: SuggestionCounts } {
  let valid = 0
  let invalid = 0
  const checked = findings.map((finding) => {
    if (finding.suggestion === undefined) return finding
    const { suggestion, ...rest } = finding
    const kept = checkSuggestion(finding, files)
    if (kept === undefined) {
      invalid++
      return rest
    }
    valid++
    return { ...rest, suggestion }
  })
  return valid + invalid === 0
    ? { findings: checked }
    : { findings: checked, counts: { valid, invalid, dropped: 0 } }
}
