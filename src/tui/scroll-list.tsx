import { Box, Text } from 'ink'
import type { Key } from 'ink'
import type { ReactNode } from 'react'
import { useRef, useState } from 'react'
import { useMessages, useScreenInput, useTheme } from './app-context.js'

export const PAGE = 10

export interface ListWindow {
  start: number
  end: number
  overflow: boolean
}

export function listWindow(
  count: number,
  index: number,
  rows: number,
  previousStart: number,
): ListWindow {
  if (count <= rows) return { start: 0, end: count, overflow: false }
  const visible = Math.max(rows - 1, 1)
  const start = Math.min(
    Math.max(Math.min(Math.max(previousStart, index - visible + 1), index), 0),
    count - visible,
  )
  return { start, end: start + visible, overflow: true }
}

export interface Selection<T> {
  index: number
  item: T | undefined
  select(key: string): void
}

export function useSelection<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  options: { active?: boolean; page?: number; initialKey?: string; onOpen?(item: T): void } = {},
): Selection<T> {
  const [selectedKey, setSelectedKey] = useState<string | undefined>(options.initialKey)
  const lastIndex = useRef(0)
  const found =
    selectedKey === undefined ? -1 : items.findIndex((item) => keyOf(item) === selectedKey)
  const index = Math.max(found >= 0 ? found : Math.min(lastIndex.current, items.length - 1), 0)
  lastIndex.current = index
  const item = items[index]
  const active = options.active ?? true
  const page = options.page ?? PAGE

  useScreenInput((_input, key) => {
    if (!active || items.length === 0) return
    const at = lastIndex.current
    if (key.return) {
      const current = items[at]
      if (current !== undefined) options.onOpen?.(current)
      return
    }
    const next = moved(at, items.length, page, key)
    const target = next === undefined ? undefined : items[next]
    if (next === undefined || target === undefined) return
    lastIndex.current = next
    setSelectedKey(keyOf(target))
  })

  const select = (key: string) => {
    const found = items.findIndex((candidate) => keyOf(candidate) === key)
    if (found >= 0) lastIndex.current = found
    setSelectedKey(key)
  }

  return { index, item, select }
}

function moved(index: number, count: number, page: number, key: Key): number | undefined {
  const last = count - 1
  if (key.upArrow) return Math.max(index - 1, 0)
  if (key.downArrow) return Math.min(index + 1, last)
  if (key.pageUp) return Math.max(index - page, 0)
  if (key.pageDown) return Math.min(index + page, last)
  if (key.home) return 0
  if (key.end) return last
  return undefined
}

export function ScrollList<T>({
  items,
  index,
  rows,
  keyOf,
  renderItem,
}: {
  items: readonly T[]
  index: number
  rows: number
  keyOf(item: T): string
  renderItem(item: T, selected: boolean): ReactNode
}) {
  const { colors } = useTheme()
  const start = useRef(0)
  const window = listWindow(items.length, index, rows, start.current)
  start.current = window.start
  return (
    <Box flexDirection="column">
      {items.slice(window.start, window.end).map((item, offset) => {
        const selected = window.start + offset === index
        return (
          <Text key={keyOf(item)} wrap="truncate-end" bold={selected}>
            {selected ? <Text color={colors.accent}>❯ </Text> : '  '}
            {renderItem(item, selected)}
          </Text>
        )
      })}
      {window.overflow && <RangeHint window={window} total={items.length} />}
    </Box>
  )
}

export function ScrollText({
  lines,
  rows,
  active = true,
}: {
  lines: readonly ReactNode[]
  rows: number
  active?: boolean
}) {
  const [offset, setOffset] = useState(0)
  const visible = lines.length <= rows ? lines.length : Math.max(rows - 1, 1)
  const maxOffset = Math.max(lines.length - visible, 0)
  const start = Math.min(offset, maxOffset)
  const latestStart = useRef(start)
  latestStart.current = start

  useScreenInput((_input, key) => {
    if (!active) return
    const next = moved(latestStart.current, maxOffset + 1, visible, key)
    if (next === undefined) return
    latestStart.current = next
    setOffset(next)
  })

  const window = { start, end: start + visible, overflow: lines.length > rows }
  return (
    <Box flexDirection="column">
      {lines.slice(window.start, window.end).map((line, position) => (
        <Text key={window.start + position} wrap="truncate-end">
          {line}
        </Text>
      ))}
      {window.overflow && <RangeHint window={window} total={lines.length} />}
    </Box>
  )
}

function RangeHint({ window, total }: { window: ListWindow; total: number }) {
  const messages = useMessages()
  const { colors } = useTheme()
  return (
    <Text color={colors.dim} wrap="truncate-end">
      {'  '}
      {messages.list.range(window.start + 1, window.end, total)}
    </Text>
  )
}
