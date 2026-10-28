import { Box, Text } from 'ink'
import { useEffect, useRef, useState } from 'react'
import type { ListedRepository } from '../../app/read-repositories.js'
import type { PullRequestTarget } from '../../app/requested-review.js'
import {
  useAppDeps,
  useBack,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useScreenSize,
  useTheme,
} from '../app-context.js'
import { usePolled } from '../data-hooks.js'
import { DataView } from '../data-view.js'
import { ScrollList, useSelection } from '../scroll-list.js'
import { TextFieldLine, useTextField } from '../text-field.js'
import { oneLine, wrapText } from '../text-fit.js'

export function PickStep({
  typing,
  back,
  onTarget,
  onRepo,
}: {
  typing: boolean
  back(): void
  onTarget(target: PullRequestTarget): void
  onRepo(repo: string): void
}) {
  const { parsePullRequest, readRepositories } = useAppDeps()
  const messages = useMessages()
  const { colors } = useTheme()
  const size = useScreenSize()
  const m = messages.reviewFlow
  const [refused, setRefused] = useState<string>()
  const field = useTextField({
    onSubmit: (text) => {
      if (text.trim() === '') return setRefused(undefined)
      const target = parsePullRequest(text)
      if (target === undefined) return setRefused(text)
      onTarget(target)
    },
  })
  const focus = useRef(field.focus)
  focus.current = field.focus
  const focusOnOpen = useRef(typing)
  useEffect(() => {
    if (focusOnOpen.current) focus.current()
  }, [])
  const state = usePolled(readRepositories)
  const repositories = state.status === 'ready' ? state.value.repositories : []
  const selection = useSelection(repositories, ({ repo }: ListedRepository) => repo, {
    active: !field.focused,
    onOpen: ({ repo }) => onRepo(repo),
  })
  useBack(back)
  useScreenInput((input) => {
    if (input === 't') field.focus()
  })
  useScreenKeys(
    field.focused
      ? [
          { keys: 'Enter', label: m.start },
          { keys: 'Esc', label: messages.field.cancel },
        ]
      : [
          ...(repositories.length === 0
            ? []
            : [
                { keys: '↑/↓', label: messages.keys.select },
                { keys: 'Enter', label: messages.keys.open },
              ]),
          { keys: 't', label: m.type },
          { keys: 'Esc', label: messages.keys.back },
        ],
  )
  const head = [
    ...wrapText(m.typeHint, size.columns).map((line) => <Text color={colors.dim}>{line}</Text>),
    <TextFieldLine label={m.pullRequest} field={field} />,
    ...(refused === undefined
      ? []
      : wrapText(m.notAPullRequest(oneLine(refused)), size.columns).map((line) => (
          <Text color={colors.error}>{line}</Text>
        ))),
    <Text> </Text>,
    <Text bold>{m.repositories}</Text>,
  ]
  return (
    <Box flexDirection="column" width={size.columns}>
      {head.map((line, index) => (
        <Text key={index} wrap="truncate-end">
          {line}
        </Text>
      ))}
      <DataView state={state}>
        {() =>
          repositories.length === 0 ? (
            <Text color={colors.dim}>{m.noRepositories}</Text>
          ) : (
            <ScrollList
              items={repositories}
              index={selection.index}
              rows={Math.max(size.rows - head.length, 1)}
              keyOf={({ repo }) => repo}
              renderItem={({ repo }) => oneLine(repo)}
            />
          )
        }
      </DataView>
    </Box>
  )
}
