import { Box, Text } from 'ink'
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { PickableRepository } from '../app/read-user-repositories.js'
import type { UserConfigChange, UserConfigPlan } from '../config/user-config-edit.js'
import {
  useAppDeps,
  useBack,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useScreenSize,
  useTheme,
} from './app-context.js'
import type { KeyHint } from './app-context.js'
import { configChangeLines, useConfigChange } from './config-change.js'
import { useLoaded } from './data-hooks.js'
import { failedLines } from './data-view.js'
import type { UiMessages } from './i18n/messages.js'
import { relativeTime } from './relative-time.js'
import { ScrollList, useSelection } from './scroll-list.js'
import { textWidth } from './tab-layout.js'
import { TextFieldLine, useTextField } from './text-field.js'
import { fit, oneLine, wrapText } from './text-fit.js'

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/
const MARK_WIDTH = 4
const CURSOR_WIDTH = 2
const GAP = '  '
const MIN_NAME_WIDTH = 20

const USER_REPOS_KEY = 'user-repos'

interface PickRow {
  key: string
  name: string
  watched: boolean
  repository: PickableRepository | undefined
}

export interface PickerContinue {
  label: string
  run(): void
}

export function RepositoryPicker({
  intro,
  noToken,
  onSaved,
  onContinue,
}: {
  intro: string
  noToken: string
  onSaved(plan: UserConfigPlan): void
  onContinue?: PickerContinue
}) {
  const { readUserRepositories, home, now } = useAppDeps()
  const messages = useMessages()
  const theme = useTheme()
  const { colors } = theme
  const size = useScreenSize()
  const m = messages.repositories.pick
  const { state, reload } = useLoaded(USER_REPOS_KEY, readUserRepositories)
  const [marks, setMarks] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [typed, setTyped] = useState<readonly string[]>([])
  const [invalid, setInvalid] = useState<string>()

  const read = state.status === 'ready' ? state.value : undefined
  const rows = pickRows(read?.repositories ?? [], typed)
  const marked = (row: PickRow) => marks.get(row.key) ?? row.watched
  const mark = (key: string, on: boolean) => setMarks((current) => new Map(current).set(key, on))

  const change = useConfigChange((plan) => {
    setMarks(new Map())
    setTyped([])
    reload()
    onSaved(plan)
  })
  const filter = useTextField()
  const add = useTextField({
    emptyOnFocus: true,
    onSubmit: (value) => {
      const name = value.trim()
      if (name === '') return
      if (!REPO_NAME.test(name)) return setInvalid(name)
      const key = keyOf(name)
      if (!rows.some((row) => row.key === key)) setTyped((current) => [...current, name])
      mark(key, true)
    },
  })
  const text = filter.draft.trim()
  const shown = text === '' ? rows : rows.filter(({ key }) => key.includes(text.toLowerCase()))
  const picking = read !== undefined && read.status !== 'no-token'
  const listing = picking && !change.open && !filter.focused && !add.focused
  const selection = useSelection(shown, ({ key }) => key, { active: listing })
  const changes = configChanges(rows, marked)

  useBack(change.open ? change.cancel : undefined)
  useScreenInput((input, key) => {
    if (read?.status === 'no-token') {
      if (key.return) onContinue?.run()
      return
    }
    if (!listing) return
    if (input === ' ' && selection.item !== undefined) {
      return mark(selection.item.key, !marked(selection.item))
    }
    if (input === 'f') return filter.focus()
    if (input === 'a') {
      setInvalid(undefined)
      return add.focus()
    }
    if (!key.return) return
    if (changes.length > 0) change.propose(changes)
    else onContinue?.run()
  })

  const keys = messages.repositories.pick.keys
  useScreenKeys(
    change.open
      ? change.keys
      : filter.focused || add.focused
        ? [
            { keys: 'Enter', label: messages.field.apply },
            { keys: 'Esc', label: messages.field.cancel },
          ]
        : read?.status === 'no-token'
          ? continueKeys(onContinue)
          : picking
            ? [
                ...(shown.length === 0
                  ? []
                  : [
                      { keys: '↑/↓', label: messages.keys.select },
                      { keys: keys.space, label: keys.mark },
                    ]),
                { keys: 'f', label: keys.filter },
                { keys: 'a', label: keys.add },
                ...(changes.length > 0
                  ? [{ keys: 'Enter', label: messages.config.keys.save }]
                  : continueKeys(onContinue)),
                { keys: 'r', label: messages.keys.refresh },
              ]
            : [{ keys: 'r', label: messages.keys.refresh }],
  )

  const wrapped = (value: string, color?: string) =>
    wrapText(value, size.columns).map((line) => <Text color={color}>{line}</Text>)
  const head: ReactNode[] = [...wrapped(intro), <Text> </Text>]
  if (read === undefined) {
    const status =
      state.status === 'failed'
        ? failedLines(messages, state.error, size.columns).map((line) => (
            <Text color={colors.error}>{line}</Text>
          ))
        : [<Text color={colors.dim}>{m.listing}</Text>]
    return <Lines lines={[...head, ...status]} />
  }
  if (read.status === 'no-token')
    return <Lines lines={[...head, ...wrapped(noToken, colors.warn)]} />

  const status: ReactNode[] = [
    ...(read.status === 'failed'
      ? [
          ...wrapped(m.failed(oneLine(read.error)), colors.error),
          ...wrapped(m.typeHint, colors.dim),
        ]
      : rows.length === 0
        ? wrapped(m.none, colors.dim)
        : []),
    ...(rows.length === 0
      ? []
      : [<Text bold>{m.count(shown.length, rows.length, rows.filter(marked).length)}</Text>]),
    ...(filter.focused || filter.value !== ''
      ? [<TextFieldLine label={m.filter} field={filter} />]
      : []),
    ...(add.focused ? [<TextFieldLine label={m.field} field={add} />] : []),
    ...(invalid === undefined ? [] : wrapped(m.invalid(oneLine(invalid)), colors.error)),
  ]
  const tail = spaced(
    configChangeLines(change.state, { messages, theme, home, width: size.columns }),
  )
  const room = Math.max(size.rows - head.length - status.length - tail.length, 1)
  const time = now()
  const details = (row: PickRow) => rowDetails(row, messages, time)
  const nameWidth = Math.min(
    Math.max(MIN_NAME_WIDTH, ...rows.map(({ name }) => textWidth(oneLine(name)))),
    Math.max(
      size.columns -
        CURSOR_WIDTH -
        MARK_WIDTH -
        GAP.length -
        Math.max(0, ...rows.map((row) => textWidth(details(row)))),
      MIN_NAME_WIDTH,
    ),
  )
  const list =
    shown.length === 0 ? (
      text === '' ? null : (
        <Text color={colors.dim}>{m.noMatch(oneLine(text))}</Text>
      )
    ) : (
      <ScrollList
        items={shown}
        index={selection.index}
        rows={room}
        keyOf={({ key }) => key}
        renderItem={(row) => (
          <>
            <Text color={marked(row) ? colors.ok : colors.dim}>
              {marked(row) ? '[x] ' : '[ ] '}
            </Text>
            {fit(oneLine(row.name), nameWidth, 'start')}
            <Text color={colors.dim}>
              {GAP}
              {details(row)}
            </Text>
          </>
        )}
      />
    )
  return (
    <Box flexDirection="column" width={size.columns}>
      {[...head, ...status].map((line, index) => (
        <Text key={index} wrap="truncate-end">
          {line}
        </Text>
      ))}
      {list}
      {tail.map((line, index) => (
        <Text key={`tail-${index}`} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  )
}

function Lines({ lines }: { lines: readonly ReactNode[] }) {
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  )
}

function pickRows(
  repositories: readonly PickableRepository[],
  typed: readonly string[],
): PickRow[] {
  const listed = repositories.map((repository) => ({
    key: keyOf(repository.name),
    name: repository.name,
    watched: repository.watched,
    repository,
  }))
  const known = new Set(listed.map(({ key }) => key))
  const added = typed
    .filter((name) => !known.has(keyOf(name)))
    .map((name) => ({ key: keyOf(name), name, watched: false, repository: undefined }))
  return [...added, ...listed]
}

function configChanges(rows: readonly PickRow[], marked: (row: PickRow) => boolean) {
  const watch: UserConfigChange[] = rows
    .filter((row) => marked(row) && !row.watched)
    .map(({ name }) => ({ kind: 'watch', repo: name }))
  const unwatch: UserConfigChange[] = rows
    .filter((row) => !marked(row) && row.watched)
    .map(({ name }) => ({ kind: 'unwatch', repo: name }))
  return [...watch, ...unwatch]
}

function rowDetails(row: PickRow, messages: UiMessages, now: Date): string {
  const m = messages.repositories.pick
  const repository = row.repository
  if (repository === undefined) return ''
  if (!repository.listed) return m.notListed
  return [
    ...(repository.private ? [m.private] : []),
    ...(repository.fork ? [m.fork] : []),
    ...(repository.pushedAt === null
      ? []
      : [relativeTime(repository.pushedAt, now, messages.time)]),
  ].join(' · ')
}

function continueKeys(onContinue: PickerContinue | undefined): KeyHint[] {
  return onContinue === undefined ? [] : [{ keys: 'Enter', label: onContinue.label }]
}

function spaced(lines: ReactNode[]): ReactNode[] {
  return lines.length === 0 ? [] : [<Text> </Text>, ...lines]
}

function keyOf(name: string): string {
  return name.trim().toLowerCase()
}
