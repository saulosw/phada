import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { useState } from 'react'
import type { AcceptedLesson } from '../../app/decide-lesson.js'
import { lessonRuleId, lessonThreads } from '../../app/lesson-rule.js'
import type { FeedbackCounts } from '../../app/read-history.js'
import { repliedKinds } from '../../app/reply-kinds.js'
import type { Learnings, MissCounts, RepoLearnings } from '../../app/read-learnings.js'
import {
  useAppDeps,
  useBack,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useScreenSize,
  useTheme,
} from '../app-context.js'
import type { KeyHint } from '../app-context.js'
import { POLL_MS, usePolled } from '../data-hooks.js'
import { DataView } from '../data-view.js'
import { failedNodes, textLines } from '../frame-lines.js'
import type { DrawContext } from '../frame-lines.js'
import type { UiMessages } from '../i18n/messages.js'
import { absoluteTime, relativeTime } from '../relative-time.js'
import { ScrollList, ScrollText, useSelection } from '../scroll-list.js'
import { textWidth } from '../tab-layout.js'
import { fit, oneLine, shortenHome, wrapText } from '../text-fit.js'

type Endpoint = Extract<RepoLearnings['observed'], { state: 'read' }>['edges'][number]['from']

type Lesson = RepoLearnings['lessons'][number]

type Mode = { kind: 'list' } | { kind: 'repo'; key: string } | { kind: 'lessons'; key: string }

type LessonAction = 'accept' | 'discard'

interface LessonQuestion {
  action: LessonAction
  lesson: Lesson
}

type LessonOutcome =
  | { kind: 'deciding'; action: LessonAction }
  | { kind: 'accepted'; accepted: AcceptedLesson }
  | { kind: 'discarded'; id: number }
  | { kind: 'failed'; action: LessonAction; error: unknown }

const MAX_REPO_WIDTH = 28

const MIN_LESSON_ROWS = 3

const repoKey = ({ repo }: RepoLearnings) => repo.toLowerCase()

const lessonKey = ({ id }: Lesson) => String(id)

export function LearningsScreen() {
  const { readLearnings, acceptLesson, discardLesson } = useAppDeps()
  const messages = useMessages()
  const [reads, setReads] = useState(0)
  const state = usePolled(readLearnings, POLL_MS, String(reads))
  const [mode, setMode] = useState<Mode>({ kind: 'list' })
  const [asking, setAsking] = useState<LessonQuestion | undefined>()
  const [outcome, setOutcome] = useState<LessonOutcome | undefined>()
  const repos = state.status === 'ready' ? state.value.repos : []
  const open = mode.kind === 'list' ? undefined : repos.find((repo) => repoKey(repo) === mode.key)
  const lessons = mode.kind === 'lessons' ? (open?.lessons ?? []) : []
  const deciding = outcome?.kind === 'deciding'
  const selection = useSelection(repos, repoKey, {
    active: mode.kind === 'list',
    onOpen: (repo) => setMode({ kind: 'repo', key: repoKey(repo) }),
  })
  const lessonSelection = useSelection(lessons, lessonKey, {
    active: mode.kind === 'lessons' && asking === undefined && !deciding,
  })
  const decide = ({ action, lesson }: LessonQuestion) => {
    setAsking(undefined)
    setOutcome({ kind: 'deciding', action })
    const decided: Promise<LessonOutcome | undefined> =
      action === 'accept'
        ? acceptLesson(lesson.id).then((accepted) =>
            accepted === undefined ? undefined : { kind: 'accepted', accepted },
          )
        : discardLesson(lesson.id).then(() => ({ kind: 'discarded', id: lesson.id }))
    void decided
      .then(setOutcome, (error: unknown) => setOutcome({ kind: 'failed', action, error }))
      .finally(() => setReads((count) => count + 1))
  }
  useScreenInput((input, key) => {
    if (mode.kind === 'repo') {
      if (input === 'l' && (open?.lessons.length ?? 0) > 0) {
        setOutcome(undefined)
        setMode({ kind: 'lessons', key: mode.key })
      }
      return
    }
    if (mode.kind !== 'lessons' || deciding) return
    if (asking !== undefined) {
      if (key.return) decide(asking)
      return
    }
    const lesson = lessonSelection.item
    if (lesson === undefined) return
    if (input === 'a') setAsking({ action: 'accept', lesson })
    else if (input === 'd') setAsking({ action: 'discard', lesson })
  })
  useBack(
    mode.kind === 'list'
      ? undefined
      : mode.kind === 'repo'
        ? () => setMode({ kind: 'list' })
        : asking !== undefined
          ? () => setAsking(undefined)
          : deciding
            ? () => {}
            : () => {
                setOutcome(undefined)
                setMode({ kind: 'repo', key: mode.key })
              },
  )
  useScreenKeys(screenKeys(mode, { repos, open, lessons, asking, deciding }, messages))
  return (
    <DataView state={state}>
      {(learnings) =>
        mode.kind === 'list' ? (
          <LearningsList learnings={learnings} index={selection.index} />
        ) : mode.kind === 'repo' ? (
          <RepoDetail repo={open} />
        ) : (
          <LessonsView
            repo={open}
            index={lessonSelection.index}
            asking={asking}
            outcome={outcome}
          />
        )
      }
    </DataView>
  )
}

function screenKeys(
  mode: Mode,
  view: {
    repos: readonly RepoLearnings[]
    open: RepoLearnings | undefined
    lessons: readonly Lesson[]
    asking: LessonQuestion | undefined
    deciding: boolean
  },
  messages: UiMessages,
): KeyHint[] {
  const k = messages.learnings.decide.keys
  const back = { keys: 'Esc', label: messages.keys.back }
  if (mode.kind === 'list') {
    return view.repos.length === 0
      ? []
      : [
          { keys: '↑/↓', label: messages.keys.select },
          { keys: 'Enter', label: messages.keys.open },
        ]
  }
  if (mode.kind === 'repo') {
    return [
      { keys: '↑/↓', label: messages.list.scroll },
      ...((view.open?.lessons.length ?? 0) > 0 ? [{ keys: 'l', label: k.lessons }] : []),
      back,
    ]
  }
  if (view.deciding) return []
  if (view.asking !== undefined) {
    return [
      ...(view.asking.action === 'accept' ? [{ keys: '↑/↓', label: messages.list.scroll }] : []),
      { keys: 'Enter', label: view.asking.action === 'accept' ? k.accept : k.discard },
      { keys: 'Esc', label: k.cancel },
    ]
  }
  return [
    ...(view.lessons.length === 0
      ? []
      : [
          { keys: '↑/↓', label: messages.keys.select },
          { keys: 'a', label: k.accept },
          { keys: 'd', label: k.discard },
        ]),
    back,
  ]
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
    ...[
      m.aboutRelations,
      m.aboutFeedback,
      ...(repos.some(({ misses }) => misses !== null) ? [m.aboutMisses] : []),
    ].flatMap((text) =>
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
            {repo.misses === null ? null : (
              <>
                <Text color={colors.warn}>{m.misses(repo.misses.open)}</Text>
                {' · '}
              </>
            )}
            {repo.lessons.length === 0 ? null : (
              <>
                <Text color={colors.accent}>{m.lessons(repo.lessons.length)}</Text>
                {' · '}
              </>
            )}
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
  const theme = useTheme()
  const { colors } = theme
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
  const repliesLines = ({ replies }: FeedbackCounts, indent: number) => {
    const kinds = repliedKinds(replies)
    if (kinds.length === 0) return []
    const text = kinds
      .map(({ kind, count }) => `${messages.reviews.replyKinds[kind]} ${count}`)
      .join(' · ')
    return wrapped(m.replies(text), indent, colors.dim)
  }
  const { feedback, observed } = repo
  const time = now()
  const lines: ReactNode[] = [<Text bold>{oneLine(repo.repo)}</Text>, <Text> </Text>]
  if (repo.lessons.length > 0) {
    lines.push(
      <Text bold>{d.lessons(repo.lessons.length)}</Text>,
      ...wrapped(d.lessonsHint, 2, colors.dim),
    )
    for (const lesson of repo.lessons) {
      lines.push(...lessonLines(lesson, { messages, theme, width }, 2))
    }
    lines.push(<Text> </Text>)
  }
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
      ...repliesLines(feedback, 2),
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
        ...repliesLines(rule, 4),
      )
    }
  }
  lines.push(<Text> </Text>)
  if (repo.misses !== null) {
    lines.push(
      <Text>
        <Text color={colors.soft}>{d.misses}</Text>
        {'  '}
        {missesText(repo.misses, messages)}
      </Text>,
      <Text color={colors.dim}>
        {'  '}
        {d.replayHint}{' '}
        <Text bold color={colors.accent}>
          phada misses --replay
        </Text>
      </Text>,
    )
    if (repo.lessons.length === 0) {
      lines.push(
        ...wrapped(d.noLessons, 2, colors.dim),
        <Text bold color={colors.accent}>
          {'  '}phada lessons --refresh
        </Text>,
      )
    }
    lines.push(<Text> </Text>)
  }
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

function missesText(misses: MissCounts, messages: UiMessages): string {
  const d = messages.learnings.detail
  const { latest } = misses
  return [
    d.missesOpen(misses.open),
    latest === undefined ? d.notReplayed : d.caught(latest.caught, latest.replayed, latest.version),
  ].join(' · ')
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

function LessonsView({
  repo,
  index,
  asking,
  outcome,
}: {
  repo: RepoLearnings | undefined
  index: number
  asking: LessonQuestion | undefined
  outcome: LessonOutcome | undefined
}) {
  const messages = useMessages()
  const theme = useTheme()
  const { colors } = theme
  const { home } = useAppDeps()
  const size = useScreenSize()
  const m = messages.learnings
  const d = m.decide
  if (repo === undefined) return <Text color={colors.dim}>{m.detail.gone}</Text>
  const draw: DrawContext = { messages, theme, width: size.columns }
  const { lessons } = repo
  const title = (
    <Text bold wrap="truncate-end">
      {d.title(oneLine(repo.repo), lessons.length)}
    </Text>
  )
  if (asking?.action === 'accept') {
    return (
      <Box flexDirection="column" width={size.columns}>
        {title}
        <Text> </Text>
        <ScrollText
          lines={acceptLines(asking.lesson, repo, home, draw)}
          rows={Math.max(size.rows - 2, 1)}
        />
      </Box>
    )
  }
  const status = [
    ...(asking === undefined ? [] : questionLines(asking, repo.repo, draw)),
    ...(outcome === undefined ? [] : outcomeLines(outcome, home, draw)),
  ]
  const statusRows = status.length === 0 ? 0 : status.length + 1
  const fixedRows = 2 + statusRows
  const listRows = Math.min(
    Math.max(lessons.length, 1),
    Math.max(MIN_LESSON_ROWS, Math.floor((size.rows - fixedRows) / 2)),
  )
  const selected = lessons[index]
  const preview =
    selected === undefined
      ? []
      : lessonLines(selected, draw, 0).slice(0, Math.max(size.rows - fixedRows - listRows - 1, 0))
  const missWidth = Math.max(0, ...lessons.map(({ misses }) => textWidth(m.misses(misses.length))))
  const ruleWidth = Math.max(size.columns - 4 - missWidth, 1)
  return (
    <Box flexDirection="column" width={size.columns}>
      {title}
      <Text> </Text>
      {lessons.length === 0 ? (
        <Text color={colors.dim}>{d.none}</Text>
      ) : (
        <ScrollList
          items={lessons}
          index={index}
          rows={listRows}
          keyOf={lessonKey}
          renderItem={(lesson) => (
            <>
              {fit(oneLine(lesson.rule), ruleWidth)}
              {'  '}
              <Text color={colors.warn}>{m.misses(lesson.misses.length)}</Text>
            </>
          )}
        />
      )}
      {preview.length > 0 && (
        <>
          <Text> </Text>
          {preview.map((line, position) => (
            <Text key={position} wrap="truncate-end">
              {line}
            </Text>
          ))}
        </>
      )}
      {status.length > 0 && (
        <>
          <Text> </Text>
          {status.map((line, position) => (
            <Text key={position} wrap="truncate-end">
              {line}
            </Text>
          ))}
        </>
      )}
    </Box>
  )
}

function lessonLines(lesson: Lesson, { messages, theme, width }: DrawContext, indent: number) {
  const pad = (lines: ReactNode[], by: number) =>
    lines.map((line) => (
      <Text>
        {' '.repeat(by)}
        {line}
      </Text>
    ))
  const meta = messages.learnings.detail.lessonMeta(
    lesson.scope.map(oneLine).join(', '),
    lesson.misses.length,
  )
  return [
    ...pad(textLines(lesson.rule, width - indent, theme.colors.soft), indent),
    ...pad(textLines(meta, width - indent - 2, theme.colors.dim), indent + 2),
  ]
}

function acceptLines(
  lesson: Lesson,
  repo: RepoLearnings,
  home: string,
  draw: DrawContext,
): ReactNode[] {
  const d = draw.messages.learnings.decide
  const { colors } = draw.theme
  const indented = (lines: ReactNode[]) =>
    lines.map((line) => (
      <Text>
        {'  '}
        {line}
      </Text>
    ))
  const meta = d.acceptMeta(lesson.scope.map(oneLine).join(', '), lessonThreads(lesson).length)
  return [
    ...questionLines({ action: 'accept', lesson }, repo.repo, draw),
    ...textLines(
      d.acceptTarget(lessonRuleId(lesson.id), shortenHome(oneLine(repo.lessonFile), home)),
      draw.width,
    ),
    ...indented(textLines(lesson.rule, draw.width - 2, colors.soft)),
    ...indented(textLines(meta, draw.width - 2, colors.dim)),
  ]
}

function questionLines(asking: LessonQuestion, repo: string, draw: DrawContext): ReactNode[] {
  const d = draw.messages.learnings.decide
  const question =
    asking.action === 'accept'
      ? d.acceptQuestion(asking.lesson.id, oneLine(repo))
      : d.discardQuestion(asking.lesson.id)
  return wrapText(question, draw.width).map((line) => (
    <Text bold color={draw.theme.colors.warn}>
      {line}
    </Text>
  ))
}

function outcomeLines(outcome: LessonOutcome, home: string, draw: DrawContext): ReactNode[] {
  const d = draw.messages.learnings.decide
  const { colors } = draw.theme
  switch (outcome.kind) {
    case 'deciding':
      return textLines(
        outcome.action === 'accept' ? d.accepting : d.discarding,
        draw.width,
        colors.dim,
      )
    case 'accepted': {
      const { accepted } = outcome
      return textLines(
        d.accepted(
          oneLine(accepted.ruleId),
          shortenHome(oneLine(accepted.path), home),
          accepted.created,
        ),
        draw.width,
        colors.ok,
      )
    }
    case 'discarded':
      return textLines(d.discarded(outcome.id), draw.width, colors.ok)
    case 'failed':
      return failedNodes(
        draw,
        outcome.error,
        outcome.action === 'accept' ? d.acceptFailed : d.discardFailed,
      )
  }
}
