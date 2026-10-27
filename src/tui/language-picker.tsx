import { Text } from 'ink'
import { useRef, useState } from 'react'
import type { UserConfigPlan } from '../config/user-config-edit.js'
import {
  useAppDeps,
  useBack,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useScreenSize,
  useTheme,
} from './app-context.js'
import { configChangeLines, useConfigChange } from './config-change.js'
import { usePolled } from './data-hooks.js'
import { failedText } from './data-view.js'
import { ScrollText } from './scroll-list.js'
import { fit, wrapText } from './text-fit.js'

const LANGUAGES = [
  { tag: 'en', name: 'English' },
  { tag: 'pt', name: 'Português' },
  { tag: 'es', name: 'Español' },
] as const

const NAME_WIDTH = Math.max(...LANGUAGES.map(({ name }) => name.length))
const DEFAULT_LANGUAGE = 'en'

export function LanguagePicker({ onDone }: { onDone(plan?: UserConfigPlan): void }) {
  const { readLanguage, home } = useAppDeps()
  const messages = useMessages()
  const theme = useTheme()
  const size = useScreenSize()
  const read = usePolled(readLanguage)
  const current = read.status === 'ready' ? baseOf(read.value) : DEFAULT_LANGUAGE
  const [picked, setPicked] = useState<number>()
  const pickedNow = useRef<number | undefined>(undefined)
  const currentIndex = Math.max(
    LANGUAGES.findIndex(({ tag }) => tag === current),
    0,
  )
  const selected = picked ?? currentIndex
  const change = useConfigChange((plan) => onDone(plan))
  useBack(change.open ? change.cancel : undefined)
  const pick = (index: number) => {
    pickedNow.current = index
    setPicked(index)
  }
  const unreadable = read.status === 'failed'
  useScreenInput((_input, key) => {
    if (change.open || unreadable) return
    const at = pickedNow.current ?? currentIndex
    if (key.upArrow) return pick(Math.max(at - 1, 0))
    if (key.downArrow) return pick(Math.min(at + 1, LANGUAGES.length - 1))
    if (!key.return) return
    const tag = LANGUAGES[at]?.tag ?? DEFAULT_LANGUAGE
    if (tag === current) return onDone()
    change.propose([{ kind: 'set', key: 'language', value: tag }])
  })
  const m = messages.language
  useScreenKeys(
    change.open
      ? change.keys
      : unreadable
        ? []
        : [
            { keys: '↑/↓', label: messages.keys.select },
            { keys: 'Enter', label: m.choose },
          ],
  )
  const { colors } = theme
  const intro = [
    ...wrapText(m.intro, size.columns).map((line) => <Text>{line}</Text>),
    <Text> </Text>,
  ]
  if (read.status === 'failed') {
    const error = wrapText(failedText(messages, read.error), size.columns).map((line) => (
      <Text color={colors.error}>{line}</Text>
    ))
    return <ScrollText lines={[...intro, ...error]} rows={size.rows} />
  }
  const lines = [
    ...intro,
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

export function languageName(language: string | undefined): string {
  const tag = baseOf(language)
  return LANGUAGES.find((entry) => entry.tag === tag)?.name ?? language ?? DEFAULT_LANGUAGE
}

function baseOf(language: string | undefined): string {
  return language?.split('-', 1)[0]?.toLowerCase() ?? DEFAULT_LANGUAGE
}
