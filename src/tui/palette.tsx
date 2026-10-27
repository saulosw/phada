import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import { useMessages, useTheme } from './app-context.js'

export interface PaletteEntry {
  id: string
  label: string
  names: readonly string[]
}

export function matchEntries(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const wanted = folded(query.trim())
  return entries.filter(({ names }) => names.some((name) => folded(name).includes(wanted)))
}

function folded(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

export function Palette({
  entries,
  onPick,
  onClose,
}: {
  entries: readonly PaletteEntry[]
  onPick(id: string): void
  onClose(): void
}) {
  const messages = useMessages()
  const { colors } = useTheme()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const matches = matchEntries(entries, query)
  const current = Math.min(selected, Math.max(matches.length - 1, 0))

  useInput((input, key) => {
    if (key.escape) return onClose()
    if (key.return) {
      const pick = matches[current]
      if (pick !== undefined) onPick(pick.id)
      return
    }
    if (key.upArrow) return setSelected(Math.max(current - 1, 0))
    if (key.downArrow) return setSelected(Math.min(current + 1, matches.length - 1))
    if (key.backspace || key.delete) {
      setQuery((text) => [...text].slice(0, -1).join(''))
      return setSelected(0)
    }
    if (key.ctrl || key.meta || key.tab || input === '' || /\p{Cc}/u.test(input)) return
    setQuery((text) => text + input)
    setSelected(0)
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={2}>
      <Text>
        <Text bold color={colors.accent}>
          /{' '}
        </Text>
        <Text>{query}</Text>
        <Text inverse> </Text>
      </Text>
      <Text color={colors.dim}>{messages.palette.title}</Text>
      {matches.length === 0 ? (
        <Text color={colors.dim}>{messages.palette.empty}</Text>
      ) : (
        matches.map((entry, position) => (
          <Text key={entry.id} bold={position === current}>
            {position === current ? <Text color={colors.accent}>❯ </Text> : '  '}
            {entry.label}
          </Text>
        ))
      )}
    </Box>
  )
}
