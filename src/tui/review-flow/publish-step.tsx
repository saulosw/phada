import { Text } from 'ink'
import type { ReactNode } from 'react'
import { useState } from 'react'
import type { PublishRefusal } from '../../app/publish-saved-review.js'
import type { PublishedReview, PullRequestTarget } from '../../app/requested-review.js'
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
import { useLoaded } from '../data-hooks.js'
import type { DataState } from '../data-hooks.js'
import { failedNodes } from '../frame-lines.js'
import type { UiMessages } from '../i18n/messages.js'
import { labeledLines } from '../labeled-lines.js'
import { shortSha } from '../refs.js'
import type { Theme } from '../theme.js'
import { ScrollText } from '../scroll-list.js'
import { oneLine, wrapText } from '../text-fit.js'
import { accountText } from './confirm-step.js'
import { pullRequestText } from './flow-text.js'
import { historyLine } from './history-line.js'

export interface SavedLook {
  runId: number
  title: string | null
  comments: number
  debt: number
}

export function PublishStep({
  target,
  title,
  look,
  back,
}: {
  target: PullRequestTarget
  title: string | null
  look: SavedLook
  back(): void
}) {
  const { readGitHub, publishReview } = useAppDeps()
  const messages = useMessages()
  const theme = useTheme()
  const size = useScreenSize()
  const m = messages.reviewFlow
  const github = useLoaded('github', readGitHub)
  const [state, setState] = useState<DataState<PublishedReview> | undefined>(undefined)
  const access = github.state.status === 'ready' ? github.state.value : undefined
  const canPublish = state === undefined && access !== undefined && access.source !== null
  const publishing = state?.status === 'loading'
  useWorking(publishing)
  useBack(publishing ? () => undefined : back)
  useScreenInput((_input, key) => {
    if (!key.return || !canPublish) return
    setState({ status: 'loading' })
    publishReview(look.runId).then(
      (value) => setState({ status: 'ready', value }),
      (error: unknown) => setState({ status: 'failed', error }),
    )
  })
  useScreenKeys(
    publishing
      ? []
      : [
          ...(canPublish ? [{ keys: 'Enter', label: m.publish.publish }] : []),
          { keys: 'Esc', label: messages.keys.back },
        ],
  )
  const draw = { messages, theme, width: size.columns }
  const wrapped = (text: string, color?: string) =>
    wrapText(text, size.columns).map((line) => <Text color={color}>{line}</Text>)
  const lines: ReactNode[] =
    state === undefined
      ? [
          ...wrapped(m.publish.question).map((line) => <Text bold>{line}</Text>),
          <Text> </Text>,
          ...labeledLines(
            [
              [m.confirm.pullRequest, pullRequestText(target, title)],
              [m.confirm.as, accountText(github.state, messages)],
              [m.publish.posts, m.publish.counts(look.comments, look.debt)],
            ],
            size.columns,
            theme.colors.soft,
          ),
        ]
      : [
          <Text bold>{pullRequestText(target, title)}</Text>,
          ...(state.status === 'loading'
            ? [<Text color={theme.colors.dim}>{m.publish.publishing}</Text>]
            : state.status === 'failed'
              ? [
                  <Text color={theme.colors.error}>{m.publish.failed}</Text>,
                  ...failedNodes(draw, state.error),
                ]
              : outcomeLines(state.value, messages, wrapped, theme.colors)),
        ]
  return <ScrollText lines={lines} rows={size.rows} />
}

function outcomeLines(
  published: PublishedReview,
  messages: UiMessages,
  wrapped: (text: string, color?: string) => ReactNode[],
  colors: Theme['colors'],
): ReactNode[] {
  const m = messages.reviewFlow.publish
  switch (published.status) {
    case 'no-token':
      return wrapped(messages.reviewFlow.noToken, colors.warn)
    case 'refused':
      return wrapped(refusalText(published.refusal, messages), colors.warn)
    case 'skipped': {
      const reason = messages.reviews.detail.skipReasons[published.reason.kind]
      return wrapped(m.skipped(reason ?? published.reason.kind), colors.warn)
    }
    case 'published':
      return [
        ...wrapped(m.published(oneLine(published.url)), colors.ok),
        ...(published.stillOpen === 0 ? [] : wrapped(m.stillOpen(published.stillOpen))),
        ...(published.resolved === 0 ? [] : wrapped(m.resolved(published.resolved))),
        ...(published.history === undefined
          ? []
          : wrapped(historyLine(published.history, messages), colors.dim)),
        ...published.warnings.flatMap((warning) => wrapped(oneLine(warning), colors.warn)),
      ]
  }
}

function refusalText(refusal: PublishRefusal, messages: UiMessages): string {
  const m = messages.reviewFlow.publish.refusals
  switch (refusal.kind) {
    case 'not-found':
      return m.notFound
    case 'not-a-dry-run':
      return refusal.status === 'published' ? m.published : m.notADryRun
    case 'nothing-to-publish':
      return m.nothing
    case 'outdated':
      return m.outdated
    case 'head-moved':
      return m.headMoved(shortSha(refusal.from), shortSha(refusal.to))
  }
}
