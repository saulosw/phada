import { Box, Text } from 'ink'
import type { OpenPullRequest, PullRequestTarget } from '../../app/requested-review.js'
import {
  useAppDeps,
  useBack,
  useMessages,
  useScreenKeys,
  useScreenSize,
  useTheme,
} from '../app-context.js'
import { useLoaded } from '../data-hooks.js'
import { DataView } from '../data-view.js'
import { ScrollList, useSelection } from '../scroll-list.js'
import { fit, oneLine } from '../text-fit.js'
import { GAP } from './flow-text.js'

export function PullsStep({
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

function targetOf(repo: string, number: number): PullRequestTarget {
  const [owner = '', name = ''] = repo.split('/')
  return { owner, repo: name, number }
}
