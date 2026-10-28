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
import { textLines } from '../frame-lines.js'
import { ScrollText } from '../scroll-list.js'
import { namesText, oneLine, shortenHome, wrapText } from '../text-fit.js'
import type { IndexOutcome, SetupProgress, SetupStepProps } from './setup-steps.js'
import { useWatchedRepositories } from './watched-repositories.js'

type Command = 'watch' | 'review'

const COMMAND_TEXT: Readonly<Record<Command, string>> = {
  watch: 'phada watch',
  review: 'phada review owner/repo#N',
}

export function SummaryStep({ progress, next }: SetupStepProps) {
  const { home } = useAppDeps()
  const messages = useMessages()
  const theme = useTheme()
  const size = useScreenSize()
  const watched = useWatchedRepositories()
  const m = messages.setup.summary
  const { colors } = theme
  useScreenInput((_input, key) => {
    if (key.return) next()
  })
  useScreenKeys([{ keys: 'Enter', label: m.home }])
  const draw: ConfigDraw = { messages, theme, home, width: size.columns }
  const commands: readonly Command[] =
    watched.status === 'ready' && watched.value.length > 0 ? ['watch', 'review'] : ['review']
  const doneTexts = doneLines(progress, draw)
  const done =
    doneTexts.length === 0
      ? []
      : [<Text> </Text>, ...doneTexts.flatMap((text) => textLines(text, size.columns))]
  const lines: ReactNode[] = [
    ...writtenLines(progress.written, draw),
    ...done,
    ...(progress.skipped.length === 0
      ? []
      : [
          <Text> </Text>,
          ...textLines(
            m.skipped(progress.skipped.map((id) => messages.setup.steps[id]).join(', ')),
            size.columns,
            colors.soft,
          ),
        ]),
    <Text> </Text>,
    <Text bold>{m.now}</Text>,
    ...commands.flatMap((command) => [
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

const SHOWN_NAMES = 5

function doneLines({ indexing = [], init }: SetupProgress, draw: ConfigDraw): string[] {
  const m = draw.messages.setup.summary
  const named = (kinds: readonly IndexOutcome['kind'][]) =>
    namesText(
      indexing.filter(({ outcome }) => kinds.includes(outcome.kind)).map(({ repo }) => repo),
      SHOWN_NAMES,
    )
  const created = (init?.files ?? []).filter((file) => file.created).map(({ path }) => path)
  return [
    ...(
      [
        [m.indexed, named(['indexed'])],
        [m.notIndexed, named(['failed', 'no-token'])],
        [m.left, named(['cancelled', 'not-started'])],
      ] as const
    ).flatMap(([text, names]) => (names === '' ? [] : [text(names)])),
    ...(init === undefined || created.length === 0
      ? []
      : [m.created(shortenHome(oneLine(init.root), draw.home), namesText(created, SHOWN_NAMES))]),
  ]
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
