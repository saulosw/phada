import { applySuggestions } from '../review/apply-suggestions.js'
import type { RefusalReason } from '../review/apply-suggestions.js'
import type { SuggestedEdit } from '../review/types.js'

export interface WorkingFiles {
  read(path: string): Promise<string | undefined>
  write(path: string, text: string): Promise<void>
}

export interface FixItem {
  number: number
  finding: { file: string; suggestion?: SuggestedEdit }
}

export type LeftReason = RefusalReason | 'no-suggestion' | 'missing-file'

export interface LeftItem<T> {
  item: T
  reason: LeftReason
}

export interface AppliedFileSuggestions<T> {
  applied: T[]
  left: LeftItem<T>[]
}

export async function applyFileSuggestions<T extends FixItem>(
  items: readonly T[],
  files: WorkingFiles,
): Promise<AppliedFileSuggestions<T>> {
  const applied: T[] = []
  const left: LeftItem<T>[] = []
  const byFile = new Map<string, { item: T; suggestion: SuggestedEdit }[]>()
  for (const item of items) {
    const { file, suggestion } = item.finding
    if (suggestion === undefined) {
      left.push({ item, reason: 'no-suggestion' })
      continue
    }
    const group = byFile.get(file) ?? []
    group.push({ item, suggestion })
    byFile.set(file, group)
  }
  for (const [file, group] of byFile) {
    const text = await files.read(file)
    if (text === undefined) {
      left.push(...group.map(({ item }) => ({ item, reason: 'missing-file' as const })))
      continue
    }
    const result = applySuggestions(text, group)
    if (result.text !== text) await files.write(file, result.text)
    applied.push(...result.applied.map(({ item }) => item))
    left.push(...result.refused.map(({ item, reason }) => ({ item: item.item, reason })))
  }
  return {
    applied: applied.sort(byNumber),
    left: left.sort((a, b) => byNumber(a.item, b.item)),
  }
}

function byNumber(a: FixItem, b: FixItem): number {
  return a.number - b.number
}
