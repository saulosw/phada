import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { failedLines } from './data-view.js'
import type { UiMessages } from './i18n/messages.js'
import { wrapText } from './text-fit.js'
import type { Theme } from './theme.js'

export interface DrawContext {
  messages: UiMessages
  theme: Theme
  width: number
}

export function textLines(text: string, width: number, color?: string): ReactNode[] {
  return wrapText(text, width).map((line) => <Text color={color}>{line}</Text>)
}

export function failedNodes(
  { messages, theme, width }: DrawContext,
  error: unknown,
  say?: (message: string) => string,
): ReactNode[] {
  return failedLines(messages, error, width, say).map((line) => (
    <Text color={theme.colors.error}>{line}</Text>
  ))
}

export function spaced(lines: readonly ReactNode[]): ReactNode[] {
  return lines.length === 0 ? [] : [<Text> </Text>, ...lines]
}

export function Lines({ lines }: { lines: readonly ReactNode[] }) {
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  )
}
