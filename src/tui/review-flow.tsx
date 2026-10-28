import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { GitHubAccess } from '../app/read-home.js'
import type { ListedRepository } from '../app/read-repositories.js'
import type { SubmitResult } from '../app/submit-request.js'
import type {
  EnqueuedReview,
  OpenPullRequest,
  PullRequestTarget,
  RequestedReview,
  ReviewMode,
} from '../app/requested-review.js'
import {
  useAppDeps,
  useBack,
  useMessages,
  useQuitGuard,
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
import { absoluteTime } from './relative-time.js'
import { reviewDetailLines } from './review-detail.js'
import { NO_STEPS, stepRunning, stepsAfter } from './review-steps.js'
import type { ReviewStep, ReviewSteps } from './review-steps.js'
import { ScrollList, ScrollText, useSelection } from './scroll-list.js'
import { TextFieldLine, useTextField } from './text-field.js'
import { fit, oneLine, wrapText } from './text-fit.js'
import { durationText } from './units.js'

type FlowStep =
  | { kind: 'pick'; typing: boolean }
  | { kind: 'pulls'; repo: string }
  | { kind: 'mode'; target: PullRequestTarget; title: string | null; chosen?: ReviewMode }
  | { kind: 'confirm'; target: PullRequestTarget; title: string | null; watch?: number }
  | { kind: 'run'; target: PullRequestTarget; title: string | null; mode: ReviewMode }
  | { kind: 'enqueue'; target: PullRequestTarget; title: string | null }

const MODES: readonly ReviewMode[] = ['look', 'publish']
const TICK_MS = 1000
const GAP = '  '

export function ReviewFlow({
  repo,
  onClose,
  onQueue,
}: {
  repo?: string
  onClose(): void
  onQueue(): void
}) {
  const [stack, setStack] = useState<FlowStep[]>(() => [
    repo === undefined ? { kind: 'pick', typing: true } : { kind: 'pulls', repo },
  ])
  const step: FlowStep = stack.at(-1) ?? { kind: 'pick', typing: true }
  const go = (next: FlowStep, left: FlowStep = step) =>
    setStack((current) => [...current.slice(0, -1), left, next])
  const back = () => (stack.length <= 1 ? onClose() : setStack((current) => current.slice(0, -1)))
  const key = String(stack.length)
  switch (step.kind) {
    case 'pick':
      return (
        <PickStep
          key={key}
          typing={step.typing}
          back={back}
          onTarget={(target) =>
            go({ kind: 'mode', target, title: null }, { kind: 'pick', typing: true })
          }
          onRepo={(name) => go({ kind: 'pulls', repo: name }, { kind: 'pick', typing: false })}
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
          onMode={(mode, watch) =>
            go(
              mode === 'publish'
                ? {
                    kind: 'confirm',
                    target: step.target,
                    title: step.title,
                    ...(watch === undefined ? {} : { watch }),
                  }
                : { kind: 'run', target: step.target, title: step.title, mode },
              { ...step, chosen: mode },
            )
          }
        />
      )
    case 'confirm':
      return (
        <ConfirmStep
          key={key}
          target={step.target}
          title={step.title}
          watch={step.watch}
          back={back}
          onConfirm={() =>
            go(
              step.watch === undefined
                ? { kind: 'run', target: step.target, title: step.title, mode: 'publish' }
                : { kind: 'enqueue', target: step.target, title: step.title },
            )
          }
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
    case 'enqueue':
      return (
        <EnqueueStep
          key={key}
          target={step.target}
          title={step.title}
          onClose={onClose}
          onQueue={onQueue}
        />
      )
  }
}

function PickStep({
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

function ConfirmStep({
  target,
  title,
  watch,
  back,
  onConfirm,
}: {
  target: PullRequestTarget
  title: string | null
  watch: number | undefined
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
    ...(canPublish
      ? [{ keys: 'Enter', label: watch === undefined ? m.confirm.publish : m.confirm.queue }]
      : []),
    { keys: 'r', label: messages.keys.refresh },
    { keys: 'Esc', label: messages.keys.back },
  ])
  const lines: ReactNode[] = [
    ...wrapText(
      watch === undefined ? m.confirm.question : m.confirm.queueQuestion,
      size.columns,
    ).map((line) => <Text bold>{line}</Text>),
    <Text> </Text>,
    ...labeledLines(
      [
        [m.confirm.pullRequest, pullRequestText(target, known)],
        [m.confirm.as, accountText(github.state, messages)],
        ...(watch === undefined
          ? []
          : [[m.confirm.watch, m.confirm.watchRunning(watch)] as [string, string]]),
      ],
      size.columns,
      theme.colors.soft,
    ),
  ]
  return <ScrollText lines={lines} rows={size.rows} />
}

function EnqueueStep({
  target,
  title,
  onClose,
  onQueue,
}: {
  target: PullRequestTarget
  title: string | null
  onClose(): void
  onQueue(): void
}) {
  const { enqueueReview } = useAppDeps()
  const messages = useMessages()
  const theme = useTheme()
  const size = useScreenSize()
  const m = messages.reviewFlow
  const [state, setState] = useState<DataState<EnqueuedReview>>({ status: 'loading' })
  const request = useRef(target)
  useEffect(() => {
    let mounted = true
    enqueueReview(request.current).then(
      (value) => {
        if (mounted) setState({ status: 'ready', value })
      },
      (error: unknown) => {
        if (mounted) setState({ status: 'failed', error })
      },
    )
    return () => {
      mounted = false
    }
  }, [enqueueReview])
  const loading = state.status === 'loading'
  const submitted = state.status === 'ready' && state.value.status === 'submitted'
  useWorking(loading)
  useBack(loading ? () => undefined : onClose)
  useScreenInput((_input, key) => {
    if (key.return && submitted) onQueue()
  })
  useScreenKeys(
    loading
      ? []
      : [
          ...(submitted ? [{ keys: 'Enter', label: m.enqueue.openQueue }] : []),
          { keys: 'Esc', label: messages.keys.back },
        ],
  )
  const draw = { messages, theme, width: size.columns }
  const wrapped = (text: string, color: string | undefined) =>
    wrapText(text, size.columns).map((line) => <Text color={color}>{line}</Text>)
  const lines: ReactNode[] = [
    <Text bold>{pullRequestText(target, title)}</Text>,
    ...(state.status === 'loading'
      ? [<Text color={theme.colors.dim}>{m.enqueue.submitting}</Text>]
      : state.status === 'failed'
        ? [
            <Text color={theme.colors.error}>{m.enqueue.failed}</Text>,
            ...failedNodes(draw, state.error),
          ]
        : state.value.status === 'no-token'
          ? [<Text color={theme.colors.warn}>{m.noToken}</Text>]
          : state.value.result.status === 'refused'
            ? wrapped(
                m.enqueue.refused(refusalText(state.value.result, messages)),
                theme.colors.warn,
              )
            : wrapped(
                (state.value.result.status === 'queued' ? m.enqueue.queued : m.enqueue.joined)(
                  state.value.result.job.id,
                  oneLine(state.value.result.job.headSha.slice(0, 7)),
                ),
                theme.colors.ok,
              )),
  ]
  return <ScrollText lines={lines} rows={size.rows} />
}

function refusalText(
  refusal: Extract<SubmitResult, { status: 'refused' }>,
  messages: UiMessages,
): string {
  const r = messages.reviewFlow.enqueue.refusals
  switch (refusal.reason) {
    case 'not-watched':
      return r.notWatched
    case 'closed':
      return r.closed
    case 'external':
      return r.external
    case 'when-command':
      return r.whenCommand(refusal.message === undefined ? r.noReason : oneLine(refusal.message))
    case 'already-reviewed':
      return refusal.job === undefined ? r.alreadyReviewed : r.alreadyReviewedJob(refusal.job.id)
    case 'hourly-limit':
      return refusal.until === undefined
        ? r.hourlyLimit
        : r.hourlyLimitUntil(absoluteTime(refusal.until))
  }
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
  const m = messages.reviewFlow
  const [steps, setSteps] = useState<ReviewSteps>(NO_STEPS)
  const [outcome, setOutcome] = useState<RunOutcome>({ status: 'running' })
  const [asking, setAsking] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [, setTick] = useState(0)
  const startedAt = useRef(now().getTime())
  const request = useRef({ target, mode })
  const controller = useRef(new AbortController())
  const publishingNow = useRef(false)
  const settled = useRef<Promise<void>>(Promise.resolve())
  const running = outcome.status === 'running'
  const publishing = steps.steps.some(({ kind }) => kind === 'publish')
  const cancellable = running && !publishing && !cancelling
  const askingNow = asking && cancellable
  useWorking(running)
  useEffect(() => {
    let mounted = true
    const stop = controller.current
    const clock = () => now().getTime()
    const { target: asked, mode: chosen } = request.current
    settled.current = reviewPullRequest(
      asked,
      chosen,
      (event) => {
        if (event.kind === 'publishing') publishingNow.current = true
        if (mounted) setSteps((current) => stepsAfter(current, event, clock()))
      },
      stop.signal,
    ).then(
      (review) => {
        if (mounted) setOutcome({ status: 'done', review, endedAt: clock() })
      },
      (error: unknown) => {
        if (mounted) setOutcome({ status: 'failed', error, endedAt: clock() })
      },
    )
    return () => {
      mounted = false
      stop.abort()
    }
  }, [reviewPullRequest, now])
  useEffect(
    () => (running ? scheduler.every(TICK_MS, () => setTick((tick) => tick + 1)) : undefined),
    [running, scheduler],
  )
  const cancel = () => {
    setAsking(false)
    setCancelling(true)
    controller.current.abort()
  }
  useQuitGuard(
    running
      ? {
          question: m.quitWhileRunning,
          stop: () => {
            controller.current.abort()
            return publishingNow.current ? settled.current : undefined
          },
          abort: () => controller.current.abort(),
        }
      : undefined,
  )
  useBack(
    !running
      ? onClose
      : askingNow
        ? () => setAsking(false)
        : cancellable
          ? () => setAsking(true)
          : () => undefined,
  )
  useScreenInput((_input, key) => {
    if (askingNow && key.return) cancel()
  })
  useScreenKeys(
    askingNow
      ? [
          { keys: 'Enter', label: m.cancel.confirm },
          { keys: 'Esc', label: m.cancel.keep },
        ]
      : cancellable
        ? [{ keys: 'Esc', label: m.cancel.key }]
        : running
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
      <Text color={theme.colors.dim}>{m.running[mode]}</Text>,
      ...(askingNow
        ? [
            <Text bold color={theme.colors.warn}>
              {m.cancel.question}
            </Text>,
          ]
        : cancelling
          ? [<Text color={theme.colors.warn}>{m.cancel.cancelling}</Text>]
          : []),
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
          <Text color={theme.colors.error}>{m.failed}</Text>,
          ...failedNodes(draw, outcome.error),
          ...spaced(stepLines(steps, target, draw, outcome.endedAt)),
          ...spaced(warningLines(steps.warnings, draw)),
        ]
      : outcome.review.status === 'cancelled'
        ? [
            <Text bold>{header}</Text>,
            <Text color={theme.colors.warn}>{m.cancel.cancelled}</Text>,
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
  review: Exclude<RequestedReview, { status: 'cancelled' }>,
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
