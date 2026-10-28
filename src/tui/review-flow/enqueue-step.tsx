import { Text } from 'ink'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { EnqueuedReview, PullRequestTarget } from '../../app/requested-review.js'
import {
  useAppDeps,
  useBack,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useScreenSize,
  useTheme,
  useWorking,
} from '../app-context.js'
import type { DataState } from '../data-hooks.js'
import { failedNodes } from '../frame-lines.js'
import { refusalText } from '../refusal-text.js'
import { ScrollText } from '../scroll-list.js'
import { wrapText } from '../text-fit.js'
import { shortSha } from '../refs.js'
import { pullRequestText } from './flow-text.js'

export function EnqueueStep({
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
                  shortSha(state.value.result.job.headSha),
                ),
                theme.colors.ok,
              )),
  ]
  return <ScrollText lines={lines} rows={size.rows} />
}
