import { Text } from 'ink'
import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { useMessages, useTheme } from './app-context.js'
import type { KeyHint } from './app-context.js'
import type { UiMessages } from './i18n/messages.js'
import { useIndexSeries } from './index-series.js'
import type { SeriesEntry, SeriesPhase } from './index-series.js'
import { fit, oneLine } from './text-fit.js'
import type { Theme } from './theme.js'

export interface RepositoryIndexing {
  busy: boolean
  start(repo: string): void
  stop(): void
  keys: KeyHint[]
  lines(width: number): ReactNode[]
}

export function useRepositoryIndexing(onEnded: () => void): RepositoryIndexing {
  const messages = useMessages()
  const theme = useTheme()
  const series = useIndexSeries()
  const ended = useRef(onEnded)
  ended.current = onEnded
  const busy = series.phase === 'running' || series.phase === 'stopping'
  useEffect(() => {
    if (series.phase === 'ended') ended.current()
  }, [series.phase])
  return {
    busy,
    start: (repo) => {
      if (!busy) series.start([repo])
    },
    stop: series.stop,
    keys: busy ? [{ keys: 'Esc', label: messages.indexing.stop }] : [],
    lines: (width) =>
      series.entries.map((entry) =>
        indexEntryLine(entry, series.phase, { messages, theme }, width),
      ),
  }
}

export function indexEntryLine(
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
  const m = messages.indexing
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
