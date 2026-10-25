import { Box, Text } from 'ink'
import { useMessages, useTheme } from '../app-context.js'

export function PlaceholderScreen() {
  const messages = useMessages()
  const { colors } = useTheme()
  return (
    <Box borderStyle="round" borderColor={colors.dim} paddingX={2} paddingY={1}>
      <Text color={colors.dim}>{messages.placeholder}</Text>
    </Box>
  )
}
