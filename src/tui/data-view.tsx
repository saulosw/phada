import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { errorMessage } from '../app/error-message.js'
import { useMessages, useScreenSize, useTheme } from './app-context.js'
import type { DataState } from './data-hooks.js'
import type { UiMessages } from './i18n/messages.js'
import { errorLines, oneLine } from './text-fit.js'

export function failedText(messages: UiMessages, error: unknown): string {
  return messages.failed(oneLine(errorMessage(error)))
}

export function failedLines(messages: UiMessages, error: unknown, width: number): string[] {
  return errorLines(failedText(messages, error), width)
}

export function DataView<T>({
  state,
  children,
}: {
  state: DataState<T>
  children: (value: T) => ReactNode
}) {
  const messages = useMessages()
  const { colors } = useTheme()
  const { columns } = useScreenSize()
  if (state.status === 'loading') return <Text color={colors.dim}>{messages.loading}</Text>
  if (state.status === 'failed') {
    return (
      <Box flexDirection="column">
        {failedLines(messages, state.error, columns).map((line, index) => (
          <Text key={index} color={colors.error}>
            {line}
          </Text>
        ))}
      </Box>
    )
  }
  return <>{children(state.value)}</>
}
