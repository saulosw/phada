import { Box, Text } from 'ink'
import { useAppDeps, useMessages, useTheme } from '../app-context.js'
import { Mascot } from '../mascot.js'

export function shortenHome(path: string, home: string): string {
  if (home === '' || home === '/') return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

export function HomeScreen() {
  const { version, cwd, home } = useAppDeps()
  const messages = useMessages()
  const { colors } = useTheme()
  return (
    <Box borderStyle="round" borderColor={colors.accent} paddingX={2} alignSelf="flex-start">
      <Box marginRight={3}>
        <Mascot />
      </Box>
      <Box flexDirection="column" justifyContent="center">
        <Text>
          <Text bold>Phada</Text>
          <Text color={colors.dim}> v{version}</Text>
        </Text>
        <Text color={colors.soft}>{messages.home.tagline}</Text>
        <Text color={colors.dim}>{shortenHome(cwd, home)}</Text>
      </Box>
    </Box>
  )
}
