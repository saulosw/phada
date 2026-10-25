import { Box, Text } from 'ink'
import type { KeyHint } from './app-context.js'
import { useTheme } from './app-context.js'
import { fitHints, HINT_SEPARATOR } from './key-hints.js'

export function Footer({
  hints,
  more,
  width,
}: {
  hints: readonly KeyHint[]
  more: KeyHint
  width: number
}) {
  const { colors } = useTheme()
  const fitted = fitHints(hints, width, more)
  const line = fitted.more ? [...fitted.shown, more] : fitted.shown
  return (
    <Box width={width}>
      <Text wrap="truncate">
        {line.map((hint, index) => (
          <Text key={`${hint.keys} ${hint.label}`}>
            {index > 0 && <Text color={colors.dim}>{HINT_SEPARATOR}</Text>}
            <Text bold color={colors.soft}>
              {hint.keys}
            </Text>
            <Text color={colors.dim}> {hint.label}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  )
}
