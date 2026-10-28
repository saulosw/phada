import { Text } from 'ink'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
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
import { failedNodes, textLines } from '../frame-lines.js'
import type { UiMessages } from '../i18n/messages.js'
import { useIndexSeries } from '../index-series.js'
import type { SeriesEntry, SeriesPhase } from '../index-series.js'
import { settle } from '../load-cache.js'
import { ScrollText } from '../scroll-list.js'
import { fit, oneLine } from '../text-fit.js'
import type { Theme } from '../theme.js'
import type { IndexOutcome, RepositoryIndexOutcome, SetupStepProps } from './setup-steps.js'

export function GraphStep({ next }: SetupStepProps) {
  const { readRepositories } = useAppDeps()
  const messages = useMessages()
  const theme = useTheme()
  const size = useScreenSize()
  const m = messages.setup.graph
  const [watched, setWatched] = useState<DataState<string[]>>({ status: 'loading' })
  const series = useIndexSeries()
  useWorking(watched.status === 'loading')
  useEffect(() => {
    let mounted = true
    void settle(async () => {
      const list = await readRepositories()
      if (list.configError !== null) throw new Error(list.configError)
      return list.repositories
        .filter(({ origins }) => origins.includes('watched'))
        .map(({ repo }) => repo)
    }).then((state) => {
      if (mounted) setWatched(state)
    })
    return () => {
      mounted = false
    }
  }, [readRepositories])

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
                    entryLine(entry, series.phase, { messages, theme }, size.columns),
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

function entryLine(
  entry: SeriesEntry,
  phase: SeriesPhase,
  { messages, theme: { colors } }: { messages: UiMessages; theme: Theme },
  width: number,
): ReactNode {
  const [icon, color, status] = entryStatus(entry, phase, messages, colors)
  return <Text color={color}>{fit(`${icon} ${oneLine(entry.repo)} · ${status}`, width)}</Text>
}

function entryStatus(
  entry: SeriesEntry,
  phase: SeriesPhase,
  messages: UiMessages,
  colors: Theme['colors'],
): [string, string | undefined, string] {
  const m = messages.setup.graph
  if (entry.state === 'waiting') {
    return ['○', colors.dim, phase === 'running' ? m.waiting : m.notStarted]
  }
  if (entry.state === 'running') {
    const { progress } = entry
    const status =
      phase === 'stopping'
        ? m.stopping
        : progress === null || progress.phase === 'fetching'
          ? m.fetching
          : m.progress(progress.done, progress.total)
    return ['◐', colors.accent, status]
  }
  const { result } = entry
  switch (result.kind) {
    case 'indexed':
      return ['●', colors.ok, m.indexed(result.files)]
    case 'cancelled':
      return ['◐', colors.warn, m.cancelled(result.extracted, result.total)]
    case 'no-token':
      return ['✕', colors.error, m.noToken]
    case 'failed':
      return ['✕', colors.error, oneLine(result.message)]
  }
}
