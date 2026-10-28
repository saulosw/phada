import { Text } from 'ink'
import type { ReactNode } from 'react'
import type { PullRequestTarget, ReviewMode } from '../../app/requested-review.js'
import {
  useAppDeps,
  useBack,
  useMessages,
  useScreenKeys,
  useScreenSize,
  useTheme,
} from '../app-context.js'
import { usePolled } from '../data-hooks.js'
import { ScrollText, useSelection } from '../scroll-list.js'
import { fit } from '../text-fit.js'
import { GAP, pullRequestText } from './flow-text.js'

const MODES: readonly ReviewMode[] = ['look', 'publish']

export function ModeStep({
  target,
  title,
  back,
  chosen,
  onMode,
}: {
  target: PullRequestTarget
  title: string | null
  back(): void
  chosen: ReviewMode | undefined
  onMode(mode: ReviewMode, watch: number | undefined): void
}) {
  const { readQueue } = useAppDeps()
  const messages = useMessages()
  const { colors } = useTheme()
  const size = useScreenSize()
  const m = messages.reviewFlow
  const queue = usePolled(readQueue)
  const watch = queue.status === 'ready' ? queue.value.holder?.pid : undefined
  const choice = (mode: ReviewMode) =>
    mode === 'publish' && watch !== undefined
      ? { label: m.queueMode.label, hint: m.queueMode.hint(watch) }
      : m.modes[mode]
  const selection = useSelection(MODES, (mode) => mode, {
    onOpen: (mode) => onMode(mode, mode === 'publish' ? watch : undefined),
    ...(chosen === undefined ? {} : { initialKey: chosen }),
  })
  useBack(back)
  useScreenKeys([
    { keys: '↑/↓', label: messages.keys.select },
    { keys: 'Enter', label: messages.keys.open },
    { keys: 'Esc', label: messages.keys.back },
  ])
  const labelWidth = Math.max(...MODES.map((mode) => choice(mode).label.length))
  const lines: ReactNode[] = [
    <Text bold>{pullRequestText(target, title)}</Text>,
    <Text> </Text>,
    <Text>{m.chooseMode}</Text>,
    ...MODES.map((mode, index) => (
      <Text bold={index === selection.index}>
        {index === selection.index ? <Text color={colors.accent}>❯ </Text> : '  '}
        {fit(choice(mode).label, labelWidth)}
        {GAP}
        <Text color={colors.dim}>{choice(mode).hint}</Text>
      </Text>
    )),
  ]
  return <ScrollText lines={lines} rows={size.rows} />
}
