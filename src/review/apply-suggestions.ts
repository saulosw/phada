import { normalize } from './suggestions.js'
import type { SuggestedEdit } from './types.js'

export type RefusalReason = 'not-found' | 'ambiguous' | 'overlap'

export interface AppliedSuggestions<T> {
  text: string
  applied: T[]
  refused: { item: T; reason: RefusalReason }[]
}

interface Range {
  start: number
  end: number
}

interface Line {
  text: string
  ending: string
}

export function applySuggestions<T extends { suggestion: SuggestedEdit }>(
  text: string,
  items: readonly T[],
): AppliedSuggestions<T> {
  const lines = text.split('\n').map(splitEnding)
  const fileLines = text.endsWith('\n') ? lines.slice(0, -1) : lines
  const placed: { item: T; range: Range }[] = []
  const refused: { item: T; reason: RefusalReason }[] = []
  for (const item of items) {
    const range = resolveRange(fileLines, item.suggestion)
    if (typeof range === 'string') {
      refused.push({ item, reason: range })
    } else if (placed.some((other) => overlaps(other.range, range))) {
      refused.push({ item, reason: 'overlap' })
    } else {
      placed.push({ item, range })
    }
  }
  const bottomUp = [...placed].sort((a, b) => b.range.start - a.range.start)
  for (const { item, range } of bottomUp) {
    const { ending } = lines[range.start]!
    const replacement = replacementLines(item.suggestion).map((text) => ({ text, ending }))
    lines.splice(range.start, range.end - range.start + 1, ...replacement)
  }
  return {
    text: lines.map((line) => line.text + line.ending).join('\n'),
    applied: placed.map(({ item }) => item),
    refused,
  }
}

function splitEnding(line: string): Line {
  return line.endsWith('\r')
    ? { text: line.slice(0, -1), ending: '\r' }
    : { text: line, ending: '' }
}

function resolveRange(lines: readonly Line[], edit: SuggestedEdit): Range | RefusalReason {
  const given = { start: edit.startLine - 1, end: edit.endLine - 1 }
  const inFile = given.start >= 0 && given.start <= given.end && given.end < lines.length
  if (edit.original === undefined) return inFile ? given : 'not-found'
  const original = normalize(edit.original).split('\n')
  if (
    inFile &&
    given.end - given.start + 1 === original.length &&
    holds(lines, given.start, original)
  ) {
    return given
  }
  const places = lines.flatMap((_, start) => (holds(lines, start, original) ? [start] : []))
  const [start, ...others] = places
  if (start === undefined) return 'not-found'
  if (others.length > 0) return 'ambiguous'
  return { start, end: start + original.length - 1 }
}

function holds(lines: readonly Line[], start: number, original: readonly string[]): boolean {
  return original.every((text, index) => lines[start + index]?.text === text)
}

function overlaps(a: Range, b: Range): boolean {
  return a.start <= b.end && b.start <= a.end
}

function replacementLines({ replacement }: SuggestedEdit): string[] {
  const code = normalize(replacement)
  return code === '' ? [] : code.split('\n')
}
