import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { PullRequestTarget, RequestedReview, ReviewMode } from '../../app/requested-review.js'
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
} from '../app-context.js'
import { errorDetailNodes, failedNodes, spaced } from '../frame-lines.js'
import type { DrawContext } from '../frame-lines.js'
import { Mascot, MASCOT_FRAMES } from '../mascot.js'
import { reviewDetailLines } from '../review-detail.js'
import { NO_STEPS, stepFailed, stepRunning, stepsAfter, stepText } from '../review-steps.js'
import type { ReviewSteps } from '../review-steps.js'
import { ScrollText } from '../scroll-list.js'
import { oneLine, wrapText } from '../text-fit.js'
import { durationText } from '../units.js'
import { pullRequestText, refText } from './flow-text.js'

const TICK_MS = 1000

type RunOutcome =
  | { status: 'running' }
  | {
      status: 'done'
      review: Exclude<RequestedReview, { status: 'watch-running' }>
      endedAt: number
    }
  | { status: 'failed'; error: unknown; endedAt: number }

export function RunStep({
  target,
  title,
  mode,
  onClose,
  onWatchRunning,
}: {
  target: PullRequestTarget
  title: string | null
  mode: ReviewMode
  onClose(): void
  onWatchRunning(pid: number): void
}) {
  const { reviewPullRequest, now, scheduler, debug } = useAppDeps()
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
  const watchRunning = useRef(onWatchRunning)
  watchRunning.current = onWatchRunning
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
        if (!mounted) return
        if (review.status === 'watch-running') watchRunning.current(review.pid)
        else setOutcome({ status: 'done', review, endedAt: clock() })
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
          ...(debug ? spaced(errorDetailNodes(draw, outcome.error, size.rows)) : []),
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
  return steps.flatMap((step, index) => {
    const running = stepRunning(step, index === steps.length - 1)
    const line = (
      <Text>
        {running ? (
          <Text color={colors.accent}>› </Text>
        ) : stepFailed(step) ? (
          <Text color={colors.error}>✕ </Text>
        ) : (
          <Text color={colors.ok}>✓ </Text>
        )}
        {stepText(step, refText(target), messages, time)}
      </Text>
    )
    if (step.kind !== 'fetch' || step.notice === undefined) return [line]
    return [
      line,
      <Text color={colors.warn}>{`  ${messages.reviewFlow.notices[step.notice]}`}</Text>,
    ]
  })
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
  review: Exclude<RequestedReview, { status: 'cancelled' | 'watch-running' }>,
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
