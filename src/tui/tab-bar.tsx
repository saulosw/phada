import { Box, Text } from 'ink'
import { useTheme } from './app-context.js'
import type { ScreenTitle } from './i18n/messages.js'
import { layoutTabs, tabText } from './tab-layout.js'

export function TabBar({
  titles,
  active,
  width,
}: {
  titles: readonly ScreenTitle[]
  active: number
  width: number
}) {
  const { colors, level } = useTheme()
  const layout = layoutTabs(titles, active, width)
  const windowed = layout.hiddenLeft || layout.hiddenRight
  return (
    <Box width={width}>
      {windowed && <Text color={colors.dim}>{layout.hiddenLeft ? '‹ ' : '  '}</Text>}
      {layout.labels.map(({ index, label }) =>
        index === active ? (
          <Text
            key={index}
            bold
            inverse={colors.accent === undefined}
            {...(colors.accent === undefined
              ? {}
              : { backgroundColor: colors.accent, color: 'white' })}
          >
            {tabText(label, level === 'none')}
          </Text>
        ) : (
          <Text key={index} color={colors.dim}>
            {tabText(label)}
          </Text>
        ),
      )}
      {windowed && <Text color={colors.dim}>{layout.hiddenRight ? ' ›' : '  '}</Text>}
    </Box>
  )
}
