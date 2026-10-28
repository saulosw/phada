import { Text } from 'ink'
import type { ReactNode } from 'react'
import {
  useBack,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useScreenSize,
  useTheme,
  useWorking,
} from '../app-context.js'
import { failedNodes, textLines } from '../frame-lines.js'
import { useIndexSeries } from '../index-series.js'
import type { SeriesEntry } from '../index-series.js'
import { indexEntryLine } from '../repository-indexing.js'
import { ScrollText } from '../scroll-list.js'
import { fit, oneLine } from '../text-fit.js'
import type { IndexOutcome, RepositoryIndexOutcome, SetupStepProps } from './setup-steps.js'
import { useWatchedRepositories } from './watched-repositories.js'

export function GraphStep({ next }: SetupStepProps) {
  const messages = useMessages()
  const theme = useTheme()
  const size = useScreenSize()
  const m = messages.setup.graph
  const watched = useWatchedRepositories()
  const series = useIndexSeries()
  useWorking(watched.status === 'loading')

  const repos = watched.status === 'ready' ? watched.value : []
  const startable = series.phase === 'idle' && repos.length > 0
  const ended =
    series.phase === 'ended' ||
    (series.phase === 'idle' && watched.status !== 'loading' && repos.length === 0)
  const busy = series.phase === 'running' || series.phase === 'stopping'
  useScreenInput((_input, key) => {
    if (!key.return) return
    if (startable) series.start(repos)
    else if (ended) next(series.phase === 'ended' ? { indexing: outcomes(series.entries) } : {})
  })
  useBack(busy ? series.stop : undefined)
  useScreenKeys(
    startable
      ? [{ keys: 'Enter', label: m.index }]
      : busy
        ? [{ keys: 'Esc', label: m.stop }]
        : ended
          ? [{ keys: 'Enter', label: messages.setup.continue }]
          : [],
  )

  const { colors } = theme
  const lines: ReactNode[] =
    watched.status === 'loading'
      ? [<Text color={colors.dim}>{m.reading}</Text>]
      : watched.status === 'failed'
        ? failedNodes({ messages, theme, width: size.columns }, watched.error)
        : repos.length === 0
          ? textLines(m.none, size.columns)
          : [
              ...textLines(m.intro, size.columns, colors.soft),
              <Text> </Text>,
              ...(series.phase === 'idle'
                ? repos.map((repo) => <Text>○ {fit(oneLine(repo), size.columns - 2)}</Text>)
                : series.entries.map((entry) =>
                    indexEntryLine(entry, series.phase, { messages, theme }, size.columns),
                  )),
              ...(series.phase === 'ended' && series.entries.some(leftForLater)
                ? [<Text> </Text>, ...textLines(m.later, size.columns, colors.dim)]
                : []),
            ]
  return <ScrollText lines={lines} rows={size.rows} />
}

function outcomes(entries: readonly SeriesEntry[]): RepositoryIndexOutcome[] {
  return entries.map((entry) => ({ repo: entry.repo, outcome: outcomeOf(entry) }))
}

function outcomeOf(entry: SeriesEntry): IndexOutcome {
  return entry.state === 'done' ? entry.result : { kind: 'not-started' }
}

function leftForLater(entry: SeriesEntry): boolean {
  const { kind } = outcomeOf(entry)
  return kind === 'cancelled' || kind === 'not-started'
}
