import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { GitHubAccess } from '../app/read-home.js'
import type { ListedRepository } from '../app/read-repositories.js'
import type {
  OpenPullRequest,
  PullRequestTarget,
  RequestedReview,
  ReviewMode,
} from '../app/requested-review.js'
import {
  useAppDeps,
  useBack,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useScreenSize,
  useTheme,
  useWorking,
} from './app-context.js'
import { useLoaded, usePolled } from './data-hooks.js'
import type { DataState } from './data-hooks.js'
import { DataView, failedText } from './data-view.js'
import { failedNodes, spaced } from './frame-lines.js'
import type { DrawContext } from './frame-lines.js'
import type { UiMessages } from './i18n/messages.js'
import { labeledLines } from './labeled-lines.js'
import { Mascot, MASCOT_FRAMES } from './mascot.js'
import { reviewDetailLines } from './review-detail.js'
import { NO_STEPS, stepRunning, stepsAfter } from './review-steps.js'
import type { ReviewStep, ReviewSteps } from './review-steps.js'
import { ScrollList, ScrollText, useSelection } from './scroll-list.js'
import { TextFieldLine, useTextField } from './text-field.js'
import { fit, oneLine, wrapText } from './text-fit.js'
import { durationText } from './units.js'

type FlowStep =
  | { kind: 'pick' }
  | { kind: 'pulls'; repo: string }
  | { kind: 'mode'; target: PullRequestTarget; title: string | null; chosen?: ReviewMode }
  | { kind: 'confirm'; target: PullRequestTarget; title: string | null }
  | { kind: 'run'; target: PullRequestTarget; title: string | null; mode: ReviewMode }

const MODES: readonly ReviewMode[] = ['look', 'publish']
const TICK_MS = 1000
const GAP = '  '

export function ReviewFlow({ repo, onClose }: { repo?: string; onClose(): void }) {
  const [stack, setStack] = useState<FlowStep[]>(() => [
    repo === undefined ? { kind: 'pick' } : { kind: 'pulls', repo },
  ])
  const step = stack.at(-1) ?? { kind: 'pick' }
  const go = (next: FlowStep) => setStack((current) => [...current, next])
  const back = () => (stack.length <= 1 ? onClose() : setStack((current) => current.slice(0, -1)))
  const key = String(stack.length)
  switch (step.kind) {
    case 'pick':
      return (
        <PickStep
          key={key}
          back={back}
          onTarget={(target) => go({ kind: 'mode', target, title: null })}
          onRepo={(name) => go({ kind: 'pulls', repo: name })}
        />
      )
    case 'pulls':
      return (
        <PullsStep
          key={key}
          repo={step.repo}
          back={back}
          onPick={(target, title) => go({ kind: 'mode', target, title })}
        />
      )
    case 'mode':
      return (
        <ModeStep
          key={key}
          target={step.target}
          title={step.title}
          back={back}
          chosen={step.chosen}
          onMode={(mode) =>
            setStack((current) => [
              ...current.slice(0, -1),
              { ...step, chosen: mode },
              mode === 'publish'
                ? { kind: 'confirm', target: step.target, title: step.title }
                : { kind: 'run', target: step.target, title: step.title, mode },
            ])
          }
        />
      )
    case 'confirm':
      return (
        <ConfirmStep
          key={key}
          target={step.target}
          title={step.title}
          back={back}
          onConfirm={() => go({ ...step, kind: 'run', mode: 'publish' })}
        />
      )
    case 'run':
      return (
        <RunStep
          key={key}
          target={step.target}
          title={step.title}
          mode={step.mode}
          onClose={onClose}
        />
      )
  }
}

function PickStep({
  back,
  onTarget,
  onRepo,
}: {
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
  useEffect(() => focus.current(), [])
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

function PullsStep({
  repo,
  back,
  onPick,
}: {
  repo: string
  back(): void
  onPick(target: PullRequestTarget, title: string | null): void
}) {
  const { readOpenPullRequests } = useAppDeps()
  const messages = useMessages()
  const theme = useTheme()
  const { colors } = theme
  const size = useScreenSize()
  const m = messages.reviewFlow
  const { state } = useLoaded(`open-pulls:${repo}`, () => readOpenPullRequests(repo))
  const pulls = state.status === 'ready' && state.value.status === 'read' ? state.value.pulls : []
  const selection = useSelection(pulls, ({ number }: OpenPullRequest) => String(number), {
    onOpen: (pull) => onPick(targetOf(repo, pull.number), pull.title),
  })
  useBack(back)
  useScreenKeys([
    ...(pulls.length === 0
      ? []
      : [
          { keys: '↑/↓', label: messages.keys.select },
          { keys: 'Enter', label: messages.keys.open },
        ]),
    { keys: 'r', label: messages.keys.refresh },
    { keys: 'Esc', label: messages.keys.back },
  ])
  const numberWidth = Math.max(0, ...pulls.map(({ number }) => String(number).length + 1))
  const authorWidth = Math.min(
    Math.max(0, ...pulls.map(({ author }) => oneLine(author).length + 1)),
    Math.floor(size.columns / 4),
  )
  const draftWidth = pulls.some(({ draft }) => draft) ? m.draft.length : 0
  const titleWidth = Math.max(
    size.columns - 2 - numberWidth - authorWidth - draftWidth - GAP.length * 3,
    0,
  )
  return (
    <Box flexDirection="column" width={size.columns}>
      <Text bold wrap="truncate-end">
        {m.openPulls(oneLine(repo))}
      </Text>
      <DataView state={state}>
        {(read) =>
          read.status === 'no-token' ? (
            <Text color={colors.warn}>{m.noToken}</Text>
          ) : pulls.length === 0 ? (
            <Text color={colors.dim}>{m.noOpenPulls}</Text>
          ) : (
            <ScrollList
              items={pulls}
              index={selection.index}
              rows={Math.max(size.rows - 1, 1)}
              keyOf={({ number }) => String(number)}
              renderItem={(pull) => (
                <>
                  {fit(`#${pull.number}`, numberWidth)}
                  {GAP}
                  {fit(oneLine(pull.title ?? ''), titleWidth)}
                  {GAP}
                  <Text color={colors.soft}>{fit(`@${oneLine(pull.author)}`, authorWidth)}</Text>
                  {draftWidth === 0 ? '' : GAP}
                  <Text color={colors.dim}>{pull.draft ? m.draft : ' '.repeat(draftWidth)}</Text>
                </>
              )}
            />
          )
        }
      </DataView>
    </Box>
  )
}

function ModeStep({
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
  onMode(mode: ReviewMode): void
}) {
  const messages = useMessages()
  const { colors } = useTheme()
  const size = useScreenSize()
  const m = messages.reviewFlow
  const selection = useSelection(MODES, (mode) => mode, {
    onOpen: onMode,
    ...(chosen === undefined ? {} : { initialKey: chosen }),
  })
  useBack(back)
  useScreenKeys([
    { keys: '↑/↓', label: messages.keys.select },
    { keys: 'Enter', label: messages.keys.open },
    { keys: 'Esc', label: messages.keys.back },
  ])
  const labelWidth = Math.max(...MODES.map((mode) => m.modes[mode].label.length))
  const lines: ReactNode[] = [
    <Text bold>{pullRequestText(target, title)}</Text>,
    <Text> </Text>,
    <Text>{m.chooseMode}</Text>,
    ...MODES.map((mode, index) => (
      <Text bold={index === selection.index}>
        {index === selection.index ? <Text color={colors.accent}>❯ </Text> : '  '}
        {fit(m.modes[mode].label, labelWidth)}
        {GAP}
        <Text color={colors.dim}>{m.modes[mode].hint}</Text>
      </Text>
    )),
  ]
  return <ScrollText lines={lines} rows={size.rows} />
}

function ConfirmStep({
  target,
  title,
  back,
  onConfirm,
}: {
  target: PullRequestTarget
  title: string | null
  back(): void
  onConfirm(): void
}) {
  const { readGitHub, readOpenPullRequests } = useAppDeps()
  const messages = useMessages()
  const theme = useTheme()
  const size = useScreenSize()
  const m = messages.reviewFlow
  const repo = `${target.owner}/${target.repo}`
  const github = useLoaded('github', readGitHub)
  const listed = useLoaded(`open-pulls:${repo}`, () => readOpenPullRequests(repo))
  const known =
    title ??
    (listed.state.status === 'ready' && listed.state.value.status === 'read'
      ? (listed.state.value.pulls.find(({ number }) => number === target.number)?.title ?? null)
      : null)
  const access = github.state.status === 'ready' ? github.state.value : undefined
  const canPublish = access !== undefined && access.source !== null
  useBack(back)
  useScreenInput((_input, key) => {
    if (key.return && canPublish) onConfirm()
  })
  useScreenKeys([
    ...(canPublish ? [{ keys: 'Enter', label: m.confirm.publish }] : []),
    { keys: 'r', label: messages.keys.refresh },
    { keys: 'Esc', label: messages.keys.back },
  ])
  const lines: ReactNode[] = [
    <Text bold>{m.confirm.question}</Text>,
    <Text> </Text>,
    ...labeledLines(
      [
        [m.confirm.pullRequest, pullRequestText(target, known)],
        [m.confirm.as, accountText(github.state, messages)],
      ],
      size.columns,
      theme.colors.soft,
    ),
  ]
  return <ScrollText lines={lines} rows={size.rows} />
}

type RunOutcome =
  | { status: 'running' }
  | { status: 'done'; review: RequestedReview; endedAt: number }
  | { status: 'failed'; error: unknown; endedAt: number }

function RunStep({
  target,
  title,
  mode,
  onClose,
}: {
  target: PullRequestTarget
  title: string | null
  mode: ReviewMode
  onClose(): void
}) {
  const { reviewPullRequest, now, scheduler } = useAppDeps()
  const messages = useMessages()
  const theme = useTheme()
  const size = useScreenSize()
  const [steps, setSteps] = useState<ReviewSteps>(NO_STEPS)
  const [outcome, setOutcome] = useState<RunOutcome>({ status: 'running' })
  const [, setTick] = useState(0)
  const startedAt = useRef(now().getTime())
  const request = useRef({ target, mode })
  const running = outcome.status === 'running'
  useWorking(running)
  useEffect(() => {
    let mounted = true
    const clock = () => now().getTime()
    const { target: asked, mode: chosen } = request.current
    reviewPullRequest(asked, chosen, (event) => {
      if (mounted) setSteps((current) => stepsAfter(current, event, clock()))
    }).then(
      (review) => {
        if (mounted) setOutcome({ status: 'done', review, endedAt: clock() })
      },
      (error: unknown) => {
        if (mounted) setOutcome({ status: 'failed', error, endedAt: clock() })
      },
    )
    return () => {
      mounted = false
    }
  }, [reviewPullRequest, now])
  useEffect(
    () => (running ? scheduler.every(TICK_MS, () => setTick((tick) => tick + 1)) : undefined),
    [running, scheduler],
  )
  useBack(running ? () => undefined : onClose)
  useScreenKeys(
    running
      ? []
      : [
          { keys: '↑/↓', label: messages.list.scroll },
          { keys: 'Esc', label: messages.keys.back },
        ],
  )
  const draw = { messages, theme, width: size.columns }
  const time = now().getTime()
  const header = pullRequestText(
    target,
    steps.steps[0]?.kind === 'fetch' ? (steps.steps[0].title ?? title) : title,
  )
  if (outcome.status === 'running') {
    const intro = [
      <Text bold>{header}</Text>,
      <Text color={theme.colors.dim}>{messages.reviewFlow.running[mode]}</Text>,
    ]
    const room = Math.max(size.rows - (MASCOT_FRAMES[0]?.length ?? 0) - 1, 1)
    return (
      <Box flexDirection="column" width={size.columns}>
        <Box>
          <Mascot />
          <Box flexDirection="column" marginLeft={2}>
            {intro.map((line, index) => (
              <Text key={index} wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
        </Box>
        <Text> </Text>
        {runningLines(steps, target, draw, time, room).map((line, index) => (
          <Text key={index} wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Box>
    )
  }
  const elapsed = durationText(outcome.endedAt - startedAt.current)
  const lines: ReactNode[] =
    outcome.status === 'failed'
      ? [
          <Text bold>{header}</Text>,
          <Text color={theme.colors.error}>{messages.reviewFlow.failed}</Text>,
          ...failedNodes(draw, outcome.error),
          ...spaced(stepLines(steps, target, draw, outcome.endedAt)),
          ...spaced(warningLines(steps.warnings, draw)),
        ]
      : resultLines(outcome.review, steps, draw, elapsed, new Date(time))
  return <ScrollText lines={lines} rows={size.rows} />
}

function runningLines(
  steps: ReviewSteps,
  target: PullRequestTarget,
  draw: DrawContext,
  time: number,
  rows: number,
): ReactNode[] {
  const done = stepLines(steps, target, draw, time)
  const warnings = steps.warnings.length === 0 ? [] : warningLines(steps.warnings, draw)
  const kept = done.slice(-rows)
  const left = rows - kept.length - 1
  if (warnings.length === 0 || left < 2) return kept
  if (warnings.length <= left) return [...kept, <Text> </Text>, ...warnings]
  const more = warnings.length - (left - 1)
  return [
    ...kept,
    <Text> </Text>,
    ...warnings.slice(0, left - 1),
    <Text color={draw.theme.colors.dim}>{`  ${draw.messages.reviewFlow.moreWarnings(more)}`}</Text>,
  ]
}

function stepLines(
  { steps }: ReviewSteps,
  target: PullRequestTarget,
  { messages, theme }: DrawContext,
  time: number,
): ReactNode[] {
  const { colors } = theme
  return steps.map((step, index) => {
    const running = stepRunning(step, index === steps.length - 1)
    return (
      <Text>
        {running ? <Text color={colors.accent}>› </Text> : <Text color={colors.ok}>✓ </Text>}
        {stepText(step, target, messages, time)}
      </Text>
    )
  })
}

function stepText(
  step: ReviewStep,
  target: PullRequestTarget,
  messages: UiMessages,
  time: number,
): string {
  const s = messages.reviewFlow.steps
  switch (step.kind) {
    case 'fetch':
      return step.title === undefined ? s.fetching(refText(target)) : s.fetched(oneLine(step.title))
    case 'context':
      return s.context(step.rules, step.docs)
    case 'conversation':
      return s.conversation(step.items)
    case 'ci':
      return s.ci(messages.reviews.ciStates[step.state] ?? oneLine(step.state))
    case 'ciWait':
      return step.waited ? s.ciWaited : s.ciWaiting(step.pending)
    case 'index':
      return s.indexing(step.done, step.total)
    case 'related':
      return s.related(step.count)
    case 'impact':
      return s.impact(step.symbols)
    case 'pass':
      return s.pass(oneLine(step.skill), step.index, step.total)
    case 'ai':
      return s.ai(
        oneLine(step.provider),
        messages.reviewFlow.runs[step.run],
        durationText((step.endedAt ?? time) - step.startedAt),
      )
    case 'publish':
      return s.publishing
  }
}

function warningLines(warnings: readonly string[], { messages, theme, width }: DrawContext) {
  if (warnings.length === 0) return []
  return [
    <Text bold color={theme.colors.warn}>
      {messages.reviewFlow.warnings(warnings.length)}
    </Text>,
    ...warnings.flatMap((warning) =>
      wrapText(warning, width - 2).map((line) => <Text>{`  ${line}`}</Text>),
    ),
  ]
}

function resultLines(
  review: RequestedReview,
  steps: ReviewSteps,
  draw: DrawContext,
  elapsed: string,
  time: Date,
): ReactNode[] {
  const { messages, theme } = draw
  const m = messages.reviewFlow
  if (review.status === 'no-token') return [<Text color={theme.colors.warn}>{m.noToken}</Text>]
  const history = review.history
  const saved =
    history.status === 'off'
      ? m.history.off
      : history.status === 'not-saved'
        ? m.history.notSaved(oneLine(history.error))
        : history.feedbackError === undefined
          ? m.history.saved
          : m.history.feedbackNotSaved(oneLine(history.feedbackError))
  return [
    <Text color={theme.colors.ok}>{m.done(elapsed)}</Text>,
    <Text color={history.status === 'not-saved' ? theme.colors.warn : theme.colors.dim}>
      {saved}
    </Text>,
    ...spaced(warningLines(steps.warnings, draw)),
    <Text> </Text>,
    ...reviewDetailLines(review.detail, draw, time),
  ]
}

function accountText(state: DataState<GitHubAccess>, messages: UiMessages): string {
  if (state.status === 'loading') return messages.loading
  if (state.status === 'failed') return failedText(messages, state.error)
  const access = state.value
  if (access.source === null) return messages.reviewFlow.noToken
  const { account } = access
  if (account.state === 'found') return `@${oneLine(account.login)}`
  if (account.state === 'refused') return messages.home.github.refused
  return messages.failed(oneLine(account.error))
}

function pullRequestText(target: PullRequestTarget, title: string | null): string {
  return title === null ? refText(target) : `${refText(target)} · ${oneLine(title)}`
}

function refText({ owner, repo, number }: PullRequestTarget): string {
  return oneLine(`${owner}/${repo}#${number}`)
}

function targetOf(repo: string, number: number): PullRequestTarget {
  const [owner = '', name = ''] = repo.split('/')
  return { owner, repo: name, number }
}
