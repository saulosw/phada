import { Box, Text } from 'ink'
import type { KeyHint } from './app-context.js'
import { useMessages, useTheme } from './app-context.js'

export function Help({
  global,
  screen,
  screenName,
}: {
  global: readonly KeyHint[]
  screen: readonly KeyHint[]
  screenName: string
}) {
  const messages = useMessages()
  const { colors } = useTheme()
  const width = Math.max(...[...global, ...screen].map(({ keys }) => [...keys].length))
  const section = (title: string, hints: readonly KeyHint[]) => (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={colors.soft}>
        {title}
      </Text>
      {hints.map(({ keys, label }) => (
        <Text key={`${keys} ${label}`}>
          {'  '}
          <Text bold color={colors.accent}>
            {keys.padEnd(width)}
          </Text>
          {'  '}
          {label}
        </Text>
      ))}
    </Box>
  )
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={2}>
      <Text bold>{messages.help.title}</Text>
      {screen.length > 0 && section(screenName, screen)}
      {section(messages.help.global, global)}
    </Box>
  )
}
