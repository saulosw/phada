import type { ScreenTitle } from './i18n/messages.js'

export interface TabLayout {
  labels: { index: number; label: string }[]
  hiddenLeft: boolean
  hiddenRight: boolean
}

const MARKER_WIDTH = 2

export function textWidth(text: string): number {
  return [...text].length
}

export function tabText(label: string, marked = false): string {
  return marked ? `[${label}]` : ` ${label} `
}

export function tabWidth(label: string): number {
  return textWidth(tabText(label))
}

export function layoutTabs(
  titles: readonly ScreenTitle[],
  active: number,
  width: number,
): TabLayout {
  for (const pick of [(title: ScreenTitle) => title.full, (title: ScreenTitle) => title.short]) {
    const labels = titles.map((title, index) => ({ index, label: pick(title) }))
    const total = labels.reduce((sum, { label }) => sum + tabWidth(label), 0)
    if (total <= width) return { labels, hiddenLeft: false, hiddenRight: false }
  }
  const short = titles.map((title) => title.short)
  const room = width - 2 * MARKER_WIDTH
  let first = active
  let last = active
  let used = tabWidth(short[active] ?? '')
  for (let grew = true; grew;) {
    grew = false
    const right = short[last + 1]
    if (right !== undefined && used + tabWidth(right) <= room) {
      last += 1
      used += tabWidth(right)
      grew = true
    }
    const left = short[first - 1]
    if (left !== undefined && used + tabWidth(left) <= room) {
      first -= 1
      used += tabWidth(left)
      grew = true
    }
  }
  return {
    labels: short.slice(first, last + 1).map((label, offset) => ({ index: first + offset, label })),
    hiddenLeft: first > 0,
    hiddenRight: last < short.length - 1,
  }
}
