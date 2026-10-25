import type { KeyHint } from './app-context.js'
import { textWidth } from './tab-layout.js'

export const HINT_SEPARATOR = ' · '

export function hintWidth({ keys, label }: KeyHint): number {
  return textWidth(keys) + 1 + textWidth(label)
}

export function fitHints(
  hints: readonly KeyHint[],
  width: number,
  more: KeyHint,
): { shown: KeyHint[]; more: boolean } {
  if (lineWidth(hints) <= width) return { shown: [...hints], more: false }
  const shown: KeyHint[] = []
  for (const hint of hints) {
    if (lineWidth([...shown, hint, more]) > width) break
    shown.push(hint)
  }
  return { shown, more: true }
}

function lineWidth(hints: readonly KeyHint[]): number {
  return hints.reduce(
    (sum, hint, index) => sum + hintWidth(hint) + (index === 0 ? 0 : HINT_SEPARATOR.length),
    0,
  )
}
