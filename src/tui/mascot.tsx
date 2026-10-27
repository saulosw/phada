import { Box, Text } from 'ink'
import { useEffect, useState } from 'react'
import { useAppDeps, useIsWorking, useTheme } from './app-context.js'

export const MASCOT_FRAMES: readonly (readonly string[])[] = [
  [' ▗▄▖ ╹ ╹ ▗▄▖ ', '▐███▙ ┃ ▟███▌', ' ▝██▛ ┃ ▜██▘ ', '   ▀  ╹  ▀   '],
  ['    ▗▖╹▗▖    ', '    ▐█┃█▌    ', '    ▝█┃█▘    ', '     ▀╹▀     '],
]

export const FLAP_MS = 450

export function Mascot() {
  const { scheduler } = useAppDeps()
  const { colors } = useTheme()
  const working = useIsWorking()
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    setFrame(0)
    if (!working) return undefined
    return scheduler.every(FLAP_MS, () =>
      setFrame((current) => (current + 1) % MASCOT_FRAMES.length),
    )
  }, [working, scheduler])
  return (
    <Box flexDirection="column">
      {(MASCOT_FRAMES[frame] ?? []).map((line, index) => (
        <Text key={index} color={colors.accent}>
          {line}
        </Text>
      ))}
    </Box>
  )
}
