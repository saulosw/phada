import { Text } from 'ink'
import type { ReactNode } from 'react'
import type { UserConfigPlan } from '../../config/user-config-edit.js'
import {
  useAppDeps,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useScreenSize,
  useTheme,
} from '../app-context.js'
import { valueChangeLines } from '../config-change.js'
import type { ConfigDraw } from '../config-change.js'
import { ScrollText } from '../scroll-list.js'
import { oneLine, shortenHome, wrapText } from '../text-fit.js'
import type { SetupStepProps } from './setup-steps.js'

const COMMANDS = ['watch', 'review'] as const

const COMMAND_TEXT: Readonly<Record<(typeof COMMANDS)[number], string>> = {
  watch: 'phada watch',
  review: 'phada review owner/repo#N',
}

export function SummaryStep({ progress, next }: SetupStepProps) {
  const { home } = useAppDeps()
  const messages = useMessages()
  const theme = useTheme()
  const size = useScreenSize()
  const m = messages.setup.summary
  const { colors } = theme
  useScreenInput((_input, key) => {
    if (key.return) next()
  })
  useScreenKeys([{ keys: 'Enter', label: m.home }])
  const draw: ConfigDraw = { messages, theme, home, width: size.columns }
  const wrapped = (text: string, color?: string) =>
    wrapText(text, size.columns).map((line) => <Text color={color}>{line}</Text>)
  const lines: ReactNode[] = [
    ...writtenLines(progress.written, draw),
    ...(progress.skipped.length === 0
      ? []
      : [
          <Text> </Text>,
          ...wrapped(
            m.skipped(progress.skipped.map((id) => messages.setup.steps[id]).join(', ')),
            colors.soft,
          ),
        ]),
    <Text> </Text>,
    <Text bold>{m.now}</Text>,
    ...COMMANDS.flatMap((command) => [
      <Text>
        {'  '}
        <Text bold color={colors.accent}>
          {COMMAND_TEXT[command]}
        </Text>
      </Text>,
      ...wrapText(m[command], size.columns - 4).map((line) => (
        <Text color={colors.dim}>
          {'    '}
          {line}
        </Text>
      )),
    ]),
  ]
  return <ScrollText lines={lines} rows={size.rows} />
}

function writtenLines(written: readonly UserConfigPlan[], draw: ConfigDraw): ReactNode[] {
  const m = draw.messages.setup.summary
  if (written.length === 0) return [<Text>{m.nothing}</Text>]
  const paths = [...new Set(written.map(({ path }) => path))]
  return paths.flatMap((path) => [
    <Text bold>{m.written(shortenHome(oneLine(path), draw.home))}</Text>,
    ...valueChangeLines(
      written.filter((plan) => plan.path === path).flatMap(({ changes }) => changes),
      draw,
    ),
  ])
}
