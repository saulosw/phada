import { Text } from 'ink'
import type { ReactNode } from 'react'
import type { GitHubAccess } from '../../app/read-home.js'
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
import { useLoaded } from '../data-hooks.js'
import type { DataState } from '../data-hooks.js'
import { failedText } from '../data-view.js'
import type { UiMessages } from '../i18n/messages.js'
import { labeledLines } from '../labeled-lines.js'
import { ScrollText } from '../scroll-list.js'
import { oneLine, wrapText } from '../text-fit.js'
import { pullRequestText } from './flow-text.js'

export function ConfirmStep({
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
