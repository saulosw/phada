import { Box, Text } from 'ink'
import { useContext, useMemo, useRef, useState } from 'react'
import {
  ScreenContext,
  useBack,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useTheme,
} from '../app-context.js'
import type { KeyHint, ScreenControls } from '../app-context.js'
import { wrapText } from '../text-fit.js'
import { SETUP_STEPS } from './setup-steps.js'
import type { SetupProgress, SetupStepProps } from './setup-steps.js'

const HEADER_ROWS = 2

export function Setup({ onClose }: { onClose(): void }) {
  const outer = useContext(ScreenContext)
  const messages = useMessages()
  const { colors } = useTheme()
  const m = messages.setup
  const [index, setIndex] = useState(0)
  const [progress, setProgress] = useState<SetupProgress>({ written: [], skipped: [] })
  const [leaving, setLeaving] = useState(false)
  const [stepKeys, setStepKeys] = useState<readonly KeyHint[]>([])
  const stepBack = useRef<(() => void) | undefined>(undefined)
  const [stepHasBack, setStepHasBack] = useState(false)
  const step = SETUP_STEPS[index] ?? SETUP_STEPS[0]
  if (step === undefined) throw new Error('the setup has no steps')

  const advance = (update: (progress: SetupProgress) => SetupProgress) => {
    setProgress(update)
    if (index === SETUP_STEPS.length - 1) onClose()
    else setIndex(index + 1)
  }
  const next: SetupStepProps['next'] = (written) =>
    advance((current) =>
      written === undefined || written.changes.length === 0
        ? current
        : { ...current, written: [...current.written, written] },
    )
  const skip = () => advance((current) => ({ ...current, skipped: [...current.skipped, step.id] }))

  useBack(() => {
    if (leaving) setLeaving(false)
    else if (stepBack.current !== undefined) stepBack.current()
    else setLeaving(true)
  })
  useScreenInput((input, key) => {
    if (leaving) {
      if (input === 'y' || key.return) onClose()
      else if (input === 'n') setLeaving(false)
      return
    }
    if (input === 's' && step.skippable) skip()
  })
  useScreenKeys(
    leaving
      ? [
          { keys: 'y/Enter', label: m.leave },
          { keys: 'n/Esc', label: m.stay },
        ]
      : [
          ...stepKeys,
          ...(step.skippable ? [{ keys: 's', label: m.skip }] : []),
          ...(stepHasBack ? [] : [{ keys: 'Esc', label: m.leave }]),
        ],
  )

  const controls = useMemo<ScreenControls>(
    () => ({
      ...outer,
      inputActive: outer.inputActive && !leaving,
      size: {
        columns: outer.size.columns,
        rows: Math.max(outer.size.rows - HEADER_ROWS, 0),
      },
      setKeys: setStepKeys,
      setBack: (back) => {
        stepBack.current = back
        setStepHasBack(back !== undefined)
      },
    }),
    [outer, leaving],
  )

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color={colors.accent}>
          {m.step(index + 1, SETUP_STEPS.length)}
        </Text>
        {' · '}
        <Text bold>{m.steps[step.id]}</Text>
      </Text>
      <Text> </Text>
      {leaving && (
        <Box flexDirection="column">
          <Text bold>{m.leaveQuestion}</Text>
          {wrapText(m.leaveHint, outer.size.columns).map((line, row) => (
            <Text key={row} color={colors.dim}>
              {line}
            </Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column" display={leaving ? 'none' : 'flex'}>
        <ScreenContext.Provider value={controls}>
          <step.Step key={step.id} progress={progress} next={next} />
        </ScreenContext.Provider>
      </Box>
    </Box>
  )
}
