import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { useState } from 'react'
import type { FeedbackCounts } from '../../app/read-history.js'
import type { Learnings, RepoLearnings } from '../../app/read-learnings.js'
import {
  useAppDeps,
  useBack,
  useMessages,
  useScreenKeys,
  useScreenSize,
  useTheme,
} from '../app-context.js'
import { usePolled } from '../data-hooks.js'
import { DataView } from '../data-view.js'
import type { UiMessages } from '../i18n/messages.js'
import { absoluteTime, relativeTime } from '../relative-time.js'
import { ScrollList, ScrollText, useSelection } from '../scroll-list.js'
import { textWidth } from '../tab-layout.js'
import { fit, oneLine, wrapText } from '../text-fit.js'

type Endpoint = Extract<RepoLearnings['observed'], { state: 'read' }>['edges'][number]['from']

const MAX_REPO_WIDTH = 28

const repoKey = ({ repo }: RepoLearnings) => repo.toLowerCase()

export function LearningsScreen() {
  const { readLearnings } = useAppDeps()
  const messages = useMessages()
  const state = usePolled(readLearnings)
  const [open, setOpen] = useState<string | undefined>()
  const repos = state.status === 'ready' ? state.value.repos : []
  const selection = useSelection(repos, repoKey, {
    active: open === undefined,
    onOpen: (repo) => setOpen(repoKey(repo)),
  })
  useBack(open === undefined ? undefined : () => setOpen(undefined))
  useScreenKeys(
    open === undefined
      ? repos.length === 0
        ? []
        : [
            { keys: '↑/↓', label: messages.keys.select },
            { keys: 'Enter', label: messages.keys.open },
          ]
      : [
          { keys: '↑/↓', label: messages.list.scroll },
          { keys: 'Esc', label: messages.keys.back },
        ],
  )
  return (
    <DataView state={state}>
      {(learnings) =>
        open === undefined ? (
          <LearningsList learnings={learnings} index={selection.index} />
        ) : (
          <RepoDetail repo={learnings.repos.find((repo) => repoKey(repo) === open)} />
        )
      }
    </DataView>
  )
}

function LearningsList({ learnings, index }: { learnings: Learnings; index: number }) {
  const messages = useMessages()
  const { colors } = useTheme()
  const size = useScreenSize()
  const m = messages.learnings
  const { repos } = learnings
  if (repos.length === 0) {
    return (
      <Box flexDirection="column" width={size.columns}>
        <Text>{learnings.recorded ? m.noneYet : m.nothing}</Text>
        <Text color={colors.dim} wrap="truncate-end">
          {m.hint}{' '}
          <Text bold color={colors.accent}>
            phada review owner/repo#N
          </Text>{' '}
          {m.or}{' '}
          <Text bold color={colors.accent}>
            phada watch
          </Text>
        </Text>
      </Box>
    )
  }
  const header = [
    <Text bold>{m.title(repos.length)}</Text>,
    ...[m.aboutRelations, m.aboutFeedback].flatMap((text) =>
      wrapText(text, size.columns).map((line) => <Text color={colors.dim}>{line}</Text>),
    ),
    <Text> </Text>,
  ]
  const repoWidth = Math.min(
    Math.max(...repos.map(({ repo }) => textWidth(oneLine(repo)))),
    MAX_REPO_WIDTH,
  )
  return (
    <Box flexDirection="column" width={size.columns}>
      {header.map((line, position) => (
        <Text key={position} wrap="truncate-end">
          {line}
        </Text>
      ))}
      <ScrollList
        items={repos}
        index={index}
        rows={Math.max(size.rows - header.length, 1)}
        keyOf={repoKey}
        renderItem={(repo) => (
          <>
            {fit(oneLine(repo.repo), repoWidth, 'start')}
            {'  '}
            <Text color={colors.soft}>{relationsText(repo, messages)}</Text>
            {' · '}
            {repo.feedback === null ? (
              <Text color={colors.dim}>{m.noComments}</Text>
            ) : (
              commentsText(repo.feedback, messages, 'present')
            )}
          </>
        )}
      />
    </Box>
  )
}

function RepoDetail({ repo }: { repo: RepoLearnings | undefined }) {
  const messages = useMessages()
  const { colors } = useTheme()
  const { now } = useAppDeps()
  const size = useScreenSize()
  const m = messages.learnings
  const d = m.detail
  if (repo === undefined) return <Text color={colors.dim}>{d.gone}</Text>
  const width = size.columns
  const wrapped = (text: string, indent: number, color?: string) =>
    wrapText(text, width - indent).map((line) => (
      <Text color={color}>
        {' '.repeat(indent)}
        {line}
      </Text>
    ))
  const { feedback, observed } = repo
  const time = now()
  const lines: ReactNode[] = [<Text bold>{oneLine(repo.repo)}</Text>, <Text> </Text>]
  if (feedback === null) lines.push(...wrapped(d.noComments, 0, colors.dim))
  else {
    lines.push(
      <Text>
        <Text color={colors.soft}>{d.published}</Text>
        {'  '}
        <Text bold>{feedback.published}</Text>
      </Text>,
      ...wrapped(outcomesText(feedback, messages, 'all'), 2),
      ...wrapped(m.marks(feedback.negativeReaction, feedback.humanReply), 2, colors.dim),
      <Text> </Text>,
      <Text bold>{d.byRule(repo.rules.length)}</Text>,
    )
    if (repo.rules.length === 0) lines.push(...wrapped(d.noRules, 2, colors.dim))
    for (const rule of repo.rules) {
      lines.push(
        <Text color={colors.soft}>
          {'  '}
          {oneLine(rule.rule)}
        </Text>,
        ...wrapped(commentsText(rule, messages, 'all'), 4),
        ...wrapped(m.marks(rule.negativeReaction, rule.humanReply), 4, colors.dim),
      )
    }
  }
  lines.push(<Text> </Text>)
  if (observed.state === 'unreadable') lines.push(...wrapped(d.unreadable, 0, colors.warn))
  else {
    const edges = observed.state === 'read' ? observed.edges : []
    lines.push(<Text bold>{d.relations(edges.length)}</Text>)
    if (edges.length === 0) lines.push(...wrapped(d.noRelations, 2, colors.dim))
    for (const edge of edges) {
      const meta = [
        `#${edge.pullRequest}`,
        ...(edge.createdAt === undefined
          ? []
          : [
              `${absoluteTime(edge.createdAt)} (${relativeTime(edge.createdAt, time, messages.time)})`,
            ]),
      ].join(' · ')
      lines.push(
        <Text>
          {'  '}
          {cutStart(endpointText(edge.from), width - 2)}
        </Text>,
        <Text>
          {'    → '}
          {cutStart(endpointText(edge.to), width - 9 - textWidth(meta))}
          <Text color={colors.dim}> · {meta}</Text>
        </Text>,
      )
    }
  }
  return <ScrollText lines={lines} rows={size.rows} />
}

function relationsText({ observed }: RepoLearnings, messages: UiMessages): string {
  const m = messages.learnings
  if (observed.state === 'unreadable') return m.unreadable
  if (observed.state === 'none' || observed.edges.length === 0) return m.noRelations
  return m.relations(observed.edges.length)
}

const OUTCOMES = ['fixed', 'dismissed', 'ignored', 'open'] as const

function commentsText(
  counts: FeedbackCounts,
  messages: UiMessages,
  shown: 'all' | 'present',
): string {
  return `${messages.learnings.comments(counts.published)}: ${outcomesText(counts, messages, shown)}`
}

function outcomesText(
  counts: FeedbackCounts,
  messages: UiMessages,
  shown: 'all' | 'present',
): string {
  return OUTCOMES.filter((outcome) => shown === 'all' || counts[outcome] > 0)
    .map((outcome) => messages.learnings.outcome[outcome](counts[outcome]))
    .join(' · ')
}

function endpointText(point: Endpoint): string {
  const name =
    point.name === undefined
      ? ''
      : ` › ${point.owner === undefined ? '' : `${point.owner}.`}${point.name}`
  return oneLine(`${point.path}${name}`)
}

function cutStart(text: string, width: number): string {
  return textWidth(text) <= width ? text : fit(text, Math.max(width, 1), 'start')
}
