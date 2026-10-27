import { Text } from 'ink'
import { useState } from 'react'
import {
  useAppDeps,
  useBack,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useScreenSize,
  useTheme,
} from '../app-context.js'
import { configChangeLines, useConfigChange } from '../config-change.js'
import { usePolled } from '../data-hooks.js'
import { ScrollText } from '../scroll-list.js'
import { fit, wrapText } from '../text-fit.js'
import type { SetupStepProps } from './setup-steps.js'

const LANGUAGES = [
  { tag: 'en', name: 'English' },
  { tag: 'pt', name: 'Português' },
  { tag: 'es', name: 'Español' },
] as const

const NAME_WIDTH = Math.max(...LANGUAGES.map(({ name }) => name.length))
const DEFAULT_LANGUAGE = 'en'

export function LanguageStep({ next }: SetupStepProps) {
  const { readLanguage, home } = useAppDeps()
  const messages = useMessages()
  const theme = useTheme()
  const size = useScreenSize()
  const read = usePolled(readLanguage)
  const current = read.status === 'ready' ? baseOf(read.value) : DEFAULT_LANGUAGE
  const [picked, setPicked] = useState<number>()
  const selected =
    picked ??
    Math.max(
      LANGUAGES.findIndex(({ tag }) => tag === current),
      0,
    )
  const change = useConfigChange((plan) => next(plan))
  useBack(change.open ? change.cancel : undefined)
  useScreenInput((_input, key) => {
    if (change.open) return
    if (key.upArrow) return setPicked(Math.max(selected - 1, 0))
    if (key.downArrow) return setPicked(Math.min(selected + 1, LANGUAGES.length - 1))
    if (!key.return) return
    const tag = LANGUAGES[selected]?.tag ?? DEFAULT_LANGUAGE
    if (tag === current) return next()
    change.propose([{ kind: 'set', key: 'language', value: tag }])
  })
  const m = messages.setup.language
  useScreenKeys(
    change.open
      ? change.keys
      : [
          { keys: '↑/↓', label: messages.keys.select },
          { keys: 'Enter', label: m.choose },
        ],
  )
  const { colors } = theme
  const lines = [
    ...wrapText(m.intro, size.columns).map((line) => <Text>{line}</Text>),
    <Text> </Text>,
    ...LANGUAGES.map(({ tag, name }, index) => (
      <Text bold={index === selected}>
        {index === selected ? <Text color={colors.accent}>❯ </Text> : '  '}
        {fit(name, NAME_WIDTH)}
        {'  '}
        <Text color={colors.soft}>{tag}</Text>
        {tag === current ? <Text color={colors.dim}> · {m.current}</Text> : ''}
      </Text>
    )),
    ...(change.open
      ? [
          <Text> </Text>,
          ...configChangeLines(change.state, { messages, theme, home, width: size.columns }),
        ]
      : []),
  ]
  return <ScrollText lines={lines} rows={size.rows} />
}

function baseOf(language: string | undefined): string {
  return language?.split('-', 1)[0]?.toLowerCase() ?? DEFAULT_LANGUAGE
}
