import { Text } from 'ink'
import type { ReactNode } from 'react'
import { errorMessage } from '../app/error-message.js'
import { useMessages, useTheme } from './app-context.js'
import type { DataState } from './data-hooks.js'

export function DataView<T>({
  state,
  children,
}: {
  state: DataState<T>
  children: (value: T) => ReactNode
}) {
  const messages = useMessages()
  const { colors } = useTheme()
  if (state.status === 'loading') return <Text color={colors.dim}>{messages.loading}</Text>
  if (state.status === 'failed') {
    return <Text color={colors.error}>{messages.failed(errorMessage(state.error))}</Text>
  }
  return <>{children(state.value)}</>
}
