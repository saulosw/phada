import { Text } from 'ink'
import { useMessages, useTheme } from '../app-context.js'

export function PendingStep() {
  const messages = useMessages()
  const { colors } = useTheme()
  return <Text color={colors.dim}>{messages.setup.pending}</Text>
}
