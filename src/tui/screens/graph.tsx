import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { useState } from 'react'
import type {
  IndexedRepository,
  IndexLanguage,
  IndexSymbolKind,
  LeftOutGroup,
  RepositoryIndexState,
} from '../../app/read-index.js'
import {
  useAppDeps,
  useBack,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useScreenSize,
  useTheme,
} from '../app-context.js'
import type { KeyHint } from '../app-context.js'
import { useLoaded } from '../data-hooks.js'
import { DataView } from '../data-view.js'
import { failedNodes, spaced, textLines } from '../frame-lines.js'
import type { DrawContext } from '../frame-lines.js'
import type { GraphMessages, UiMessages } from '../i18n/messages.js'
import { labeledLines } from '../labeled-lines.js'
import { absoluteTime, relativeTime } from '../relative-time.js'
import { useRepositoryIndexing } from '../repository-indexing.js'
import { ScrollList, ScrollText, useSelection } from '../scroll-list.js'
import { indented } from '../setting-lines.js'
import { textWidth } from '../tab-layout.js'
import { fit, oneLine, shortenHome } from '../text-fit.js'
import { bytesText, durationText } from '../units.js'

const INDEXES_KEY = 'graph-indexes'
const GAP = '  '
const MIN_NAME_WIDTH = 12
const SHORT_SHA = 7
const EXTENSIONS_SHOWN = 3
const NO_VALUE = '–'

const repoKey = ({ repo }: IndexedRepository) => repo

export function GraphScreen() {
  const { readIndexes } = useAppDeps()
  const messages = useMessages()
  const size = useScreenSize()
  const loaded = useLoaded(INDEXES_KEY, readIndexes)
  const [open, setOpen] = useState<string | undefined>()
  const indexing = useRepositoryIndexing(loaded.reload)
  const repositories = loaded.state.status === 'ready' ? loaded.state.value.repositories : []
  const selection = useSelection(repositories, repoKey, {
    active: open === undefined,
    onOpen: (entry) => setOpen(entry.repo),
  })
  const opened = open === undefined ? undefined : repositories.find((entry) => entry.repo === open)
  const target = open === undefined ? selection.item : opened

  useBack(indexing.busy ? indexing.stop : open === undefined ? undefined : () => setOpen(undefined))
  useScreenInput((input) => {
    if (input === 'i' && target !== undefined) indexing.start(target.repo)
  })
  useScreenKeys([
    ...(open === undefined
      ? repositories.length === 0
        ? []
        : [
            { keys: '↑/↓', label: messages.keys.select },
            { keys: 'Enter', label: messages.keys.open },
          ]
      : [{ keys: '↑/↓', label: messages.list.scroll }]),
    ...indexKeys(target, indexing.busy, messages),
    { keys: 'r', label: messages.keys.refresh },
    ...(open !== undefined && !indexing.busy ? [{ keys: 'Esc', label: messages.keys.back }] : []),
  ])

  const tail = spaced(indexing.lines(size.columns))
  return (
    <DataView state={loaded.state}>
      {() =>
        opened === undefined ? (
          <RepositoryList repositories={repositories} selected={selection.index} tail={tail} />
        ) : (
          <RepositoryView entry={opened} tail={tail} />
        )
      }
    </DataView>
  )
}

function indexKeys(
  target: IndexedRepository | undefined,
  busy: boolean,
  messages: UiMessages,
): KeyHint[] {
  if (busy) return [{ keys: 'Esc', label: messages.indexing.stop }]
  if (target === undefined) return []
  const fresh = target.index.state === 'missing' || target.index.state === 'empty'
  return [{ keys: 'i', label: fresh ? messages.indexing.index : messages.indexing.again }]
}

interface ListCells {
  name: string
  state: string
  commit: string
  files: string
  symbols: string
  size: string
}

function RepositoryList({
  repositories,
  selected,
  tail,
}: {
  repositories: readonly IndexedRepository[]
  selected: number
  tail: readonly ReactNode[]
}) {
  const messages = useMessages()
  const theme = useTheme()
  const { colors } = theme
  const size = useScreenSize()
  const m = messages.graph
  if (repositories.length === 0) {
    return (
      <Box flexDirection="column" width={size.columns}>
        {[
          ...textLines(m.none, size.columns),
          ...textLines(m.noneHint, size.columns, colors.dim),
          ...tail,
        ].map((line, position) => (
          <Text key={position}>{line}</Text>
        ))}
      </Box>
    )
  }
  const rows = repositories.map((entry) => ({ entry, cells: listCells(entry, m) }))
  const header: ListCells = {
    name: m.columns.repo,
    state: m.columns.state,
    commit: m.columns.commit,
    files: m.columns.files,
    symbols: m.columns.symbols,
    size: m.columns.size,
  }
  const width = (pick: (cells: ListCells) => string) =>
    Math.max(textWidth(pick(header)), ...rows.map(({ cells }) => textWidth(pick(cells))))
  const columns = {
    state: width((cells) => cells.state),
    commit: width((cells) => cells.commit),
    files: width((cells) => cells.files),
    symbols: width((cells) => cells.symbols),
    size: width((cells) => cells.size),
  }
  const fixed = Object.values(columns).reduce((sum, value) => sum + value, 0)
  const room = size.columns - 2 - fixed - GAP.length * 5
  const nameWidth = Math.max(
    Math.min(
      width((cells) => cells.name),
      room,
    ),
    MIN_NAME_WIDTH,
  )
  const line = (cells: ListCells) =>
    [
      fit(cells.name, nameWidth, 'start'),
      fit(cells.state, columns.state),
      fit(cells.commit, columns.commit),
      cells.files.padStart(columns.files),
      cells.symbols.padStart(columns.symbols),
      cells.size.padStart(columns.size),
    ].join(GAP)
  const indexedCount = repositories.filter(({ index }) => index.state === 'indexed').length
  return (
    <Box flexDirection="column" width={size.columns}>
      <Text bold wrap="truncate-end">
        {`${m.count(repositories.length)} · ${m.indexed(indexedCount)}`}
      </Text>
      <Text color={colors.dim} wrap="truncate-end">
        {'  '}
        {line(header)}
      </Text>
      <ScrollList
        items={rows}
        index={selected}
        rows={Math.max(size.rows - 2 - tail.length, 1)}
        keyOf={({ entry }) => repoKey(entry)}
        renderItem={({ entry, cells }) => (
          <Text color={stateColor(entry.index, theme.colors)}>{line(cells)}</Text>
        )}
      />
      {tail.map((node, position) => (
        <Text key={`tail-${position}`} wrap="truncate-end">
          {node}
        </Text>
      ))}
    </Box>
  )
}

function listCells({ repo, index }: IndexedRepository, m: GraphMessages): ListCells {
  const indexed = index.state === 'indexed' ? index : undefined
  return {
    name: oneLine(repo),
    state: m.states[index.state],
    commit: indexed === undefined ? NO_VALUE : indexed.snapshot.sha.slice(0, SHORT_SHA),
    files: indexed === undefined ? NO_VALUE : m.amount(indexed.summary.files.indexed),
    symbols: indexed === undefined ? NO_VALUE : m.amount(symbolTotal(indexed.summary.symbols)),
    size:
      index.state === 'missing' || index.state === 'unreadable' ? NO_VALUE : bytesText(index.bytes),
  }
}

function stateColor(
  index: RepositoryIndexState,
  colors: DrawContext['theme']['colors'],
): string | undefined {
  switch (index.state) {
    case 'indexed':
      return undefined
    case 'missing':
    case 'empty':
      return colors.dim
    case 'other-version':
      return colors.warn
    case 'unreadable':
      return colors.error
  }
}

function symbolTotal(symbols: Partial<Record<IndexSymbolKind, number>>): number {
  return Object.values(symbols).reduce((sum, count) => sum + (count ?? 0), 0)
}

function RepositoryView({ entry, tail }: { entry: IndexedRepository; tail: readonly ReactNode[] }) {
  const messages = useMessages()
  const theme = useTheme()
  const { now, home } = useAppDeps()
  const size = useScreenSize()
  const draw: DrawContext = { messages, theme, width: size.columns }
  const lines: ReactNode[] = [
    <Text bold>{oneLine(entry.repo)}</Text>,
    ...section(messages.graph.detail.index, indexLines(entry.index, draw, home, now())),
  ]
  return (
    <Box flexDirection="column" width={size.columns}>
      <ScrollText lines={lines} rows={Math.max(size.rows - tail.length, 1)} />
      {tail.map((node, position) => (
        <Text key={`tail-${position}`} wrap="truncate-end">
          {node}
        </Text>
      ))}
    </Box>
  )
}

function section(heading: string, lines: readonly ReactNode[]): ReactNode[] {
  return [<Text> </Text>, <Text bold>{heading}</Text>, ...lines]
}

function indexLines(
  index: RepositoryIndexState,
  draw: DrawContext,
  home: string,
  now: Date,
): ReactNode[] {
  const { messages, theme, width } = draw
  const { colors } = theme
  const d = messages.graph.detail
  const inner = width - 2
  const file = (bytes: number) => `${oneLine(shortenHome(index.path, home))} · ${bytesText(bytes)}`
  switch (index.state) {
    case 'missing':
      return indented(textLines(d.missing, inner, colors.dim))
    case 'empty':
      return indented([
        ...textLines(d.empty, inner, colors.dim),
        ...labeledLines([[d.file, file(index.bytes)]], inner, colors.soft),
      ])
    case 'other-version':
      return indented([
        ...textLines(
          d.otherVersion(
            {
              schemaVersion: optional(index.found.schemaVersion),
              phadaVersion: optional(index.found.phadaVersion),
            },
            {
              schemaVersion: optional(index.expected.schemaVersion),
              phadaVersion: optional(index.expected.phadaVersion),
            },
          ),
          inner,
          colors.warn,
        ),
        ...labeledLines([[d.file, file(index.bytes)]], inner, colors.soft),
      ])
    case 'unreadable':
      return indented([
        ...failedNodes({ ...draw, width: inner }, index.error),
        ...textLines(d.unreadable, inner, colors.dim),
      ])
    case 'indexed': {
      const { snapshot, summary } = index
      const leftOut = index.leftOut.reduce((sum, group) => sum + group.files, 0)
      const m = messages.graph
      return indented(
        labeledLines(
          [
            [
              d.state,
              d.indexedAt(
                relativeTime(snapshot.indexedAt, now, messages.time),
                absoluteTime(snapshot.indexedAt),
              ),
            ],
            [
              d.commit,
              `${snapshot.sha.slice(0, SHORT_SHA)} · ${snapshot.defaultBranch ? d.defaultBranch : oneLine(snapshot.ref)}`,
            ],
            [d.took, durationText(snapshot.durationMs)],
            [d.files, d.filesValue(summary.files.indexed, leftOut)],
            [d.languages, languagesText(summary.languages, m)],
            [d.symbols, symbolsText(summary.symbols, m)],
            [d.links, d.linksValue(summary)],
            [d.leftOut, index.leftOut.length === 0 ? undefined : leftOutText(index.leftOut, m)],
            [d.file, file(index.bytes)],
          ],
          inner,
          colors.soft,
        ),
      )
    }
  }
}

function optional(value: string | null): string | null {
  return value === null ? null : oneLine(value)
}

function byCount<K extends string>(counts: Partial<Record<K, number>>): [K, number][] {
  return (Object.entries(counts) as [K, number | undefined][])
    .flatMap(([key, count]): [K, number][] =>
      count === undefined || count === 0 ? [] : [[key, count]],
    )
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
}

function languagesText(
  languages: Partial<Record<IndexLanguage, number>>,
  m: GraphMessages,
): string {
  const shown = byCount(languages).map(
    ([language, count]) => `${m.languages[language]} ${m.amount(count)}`,
  )
  return shown.length === 0 ? m.detail.nothing : shown.join(' · ')
}

function symbolsText(symbols: Partial<Record<IndexSymbolKind, number>>, m: GraphMessages): string {
  const shown = byCount(symbols).map(([kind, count]) => m.symbols[kind](count))
  return shown.length === 0 ? m.detail.nothing : shown.join(' · ')
}

function leftOutText(groups: readonly LeftOutGroup[], m: GraphMessages): string {
  return groups
    .map((group) => {
      const label = m.leftOut[group.reason](group.files)
      return group.reason === 'no-grammar' && group.extensions.length > 0
        ? `${label} (${extensionsText(group, m)})`
        : label
    })
    .join(' · ')
}

function extensionsText({ extensions }: LeftOutGroup, m: GraphMessages): string {
  const shown = extensions
    .slice(0, EXTENSIONS_SHOWN)
    .map(
      ({ extension, files }) =>
        `${extension === '' ? m.detail.noExtension : oneLine(extension)} ${m.amount(files)}`,
    )
  const other = extensions.slice(EXTENSIONS_SHOWN).reduce((sum, { files }) => sum + files, 0)
  return [...shown, ...(other === 0 ? [] : [m.detail.other(other)])].join(', ')
}
