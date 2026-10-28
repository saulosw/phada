import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { useState } from 'react'
import type {
  Connection,
  Connections,
  PackageRef,
  RepositoryConnections,
} from '../../app/read-connections.js'
import type {
  IndexedRepository,
  IndexLanguage,
  IndexSymbolKind,
  LeftOutGroup,
  RepositoryIndexes,
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
import type { DataState, Loaded } from '../data-hooks.js'
import { DataView } from '../data-view.js'
import { failedNodes, spaced, textLines } from '../frame-lines.js'
import type { DrawContext } from '../frame-lines.js'
import type { GraphMessages, UiMessages } from '../i18n/messages.js'
import { labeledLines } from '../labeled-lines.js'
import { notIndexedText } from '../not-indexed-text.js'
import { absoluteTime, relativeTime } from '../relative-time.js'
import { useRepositoryIndexing } from '../repository-indexing.js'
import { ScrollList, ScrollText, useSelection } from '../scroll-list.js'
import { SubView } from '../sub-view.js'
import { SymbolExplorer } from '../symbol-explorer.js'
import { indented } from '../setting-lines.js'
import { textWidth } from '../tab-layout.js'
import { TextFieldLine, useTextField } from '../text-field.js'
import { fit, namesText, oneLine, shortenHome, wrapText } from '../text-fit.js'
import { bytesText, durationText } from '../units.js'
import { shortSha } from '../refs.js'

const INDEXES_KEY = 'graph-indexes'
const CONNECTIONS_KEY = 'graph-connections'
const PACKAGES_SHOWN = 5
const BRANCH_INDENT = 2
const GAP = '  '
const MIN_NAME_WIDTH = 12
const EXTENSIONS_SHOWN = 3
const NO_VALUE = '–'

const repoKey = ({ repo }: IndexedRepository) => repo

export function GraphScreen() {
  const { readIndexes, readConnections } = useAppDeps()
  const loaded = useLoaded(INDEXES_KEY, readIndexes)
  const connections = useLoaded(CONNECTIONS_KEY, readConnections)
  const [open, setOpen] = useState<string | undefined>()
  const [exploring, setExploring] = useState(false)
  const [symbol, setSymbol] = useState('')
  if (open !== undefined && exploring) {
    return (
      <SubView onLeave={() => setExploring(false)}>
        <SymbolExplorer repo={open} name={symbol} />
      </SubView>
    )
  }
  return (
    <GraphView
      loaded={loaded}
      connections={connections}
      open={open}
      onOpen={setOpen}
      symbol={symbol}
      onSearch={(name) => {
        setSymbol(name)
        setExploring(true)
      }}
    />
  )
}

function GraphView({
  loaded,
  connections,
  open,
  onOpen,
  symbol,
  onSearch,
}: {
  loaded: Loaded<RepositoryIndexes>
  connections: Loaded<Connections>
  open: string | undefined
  onOpen(repo: string | undefined): void
  symbol: string
  onSearch(name: string): void
}) {
  const messages = useMessages()
  const size = useScreenSize()
  const field = useTextField({
    initial: symbol,
    emptyOnFocus: true,
    onSubmit: (name) => {
      if (name.trim() !== '') onSearch(name.trim())
    },
  })
  const indexing = useRepositoryIndexing(() => {
    loaded.reload()
    connections.reload()
  })
  const repositories = loaded.state.status === 'ready' ? loaded.state.value.repositories : []
  const selection = useSelection(repositories, repoKey, {
    active: open === undefined && !field.focused,
    ...(open === undefined ? {} : { initialKey: open }),
    onOpen: (entry) => onOpen(entry.repo),
  })
  const opened = open === undefined ? undefined : repositories.find((entry) => entry.repo === open)
  const target = open === undefined ? selection.item : opened
  const unindexed =
    opened === undefined ? [] : unindexedRelated(connectionsOf(connections.state, opened.repo))

  useBack(indexing.busy ? indexing.stop : open === undefined ? undefined : () => onOpen(undefined))
  useScreenInput((input) => {
    if (input === 'i' && target !== undefined) indexing.start([target.repo])
    if (input === 'I') indexing.start(unindexed)
    if (input === 's' && opened !== undefined && !indexing.busy) field.focus()
  })
  useScreenKeys(
    field.focused
      ? [
          { keys: 'Enter', label: messages.graph.explore.run },
          { keys: 'Esc', label: messages.graph.explore.cancel },
        ]
      : [
          ...(open === undefined
            ? repositories.length === 0
              ? []
              : [
                  { keys: '↑/↓', label: messages.keys.select },
                  { keys: 'Enter', label: messages.keys.open },
                ]
            : [{ keys: '↑/↓', label: messages.list.scroll }]),
          ...(opened === undefined || indexing.busy
            ? []
            : [{ keys: 's', label: messages.graph.explore.search }]),
          ...indexKeys(target, indexing.busy, messages),
          ...(open !== undefined && !indexing.busy
            ? [{ keys: 'Esc', label: messages.keys.back }]
            : []),
          ...(indexing.busy || unindexed.length === 0
            ? []
            : [{ keys: 'I', label: messages.graph.connections.indexRelated }]),
          { keys: 'r', label: messages.keys.refresh },
        ],
  )

  const tail = spaced(indexing.lines(size.columns))
  return (
    <DataView state={loaded.state}>
      {() =>
        opened === undefined ? (
          <RepositoryList
            repositories={repositories}
            connections={connections.state}
            selected={selection.index}
            tail={tail}
          />
        ) : (
          <RepositoryView
            entry={opened}
            connections={connections.state}
            tail={
              field.focused
                ? [...tail, <TextFieldLine label={messages.graph.explore.field} field={field} />]
                : tail
            }
          />
        )
      }
    </DataView>
  )
}

function connectionsOf(
  state: DataState<Connections>,
  repo: string,
): RepositoryConnections | undefined {
  return state.status === 'ready'
    ? state.value.repositories.find((entry) => entry.repo === repo)
    : undefined
}

function unindexedRelated(entry: RepositoryConnections | undefined): string[] {
  if (entry?.declared.status !== 'read') return []
  return entry.declared.related
    .filter(({ link }) => link.state === 'not-indexed')
    .map(({ repo }) => repo)
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
  linked: string
}

function RepositoryList({
  repositories,
  connections,
  selected,
  tail,
}: {
  repositories: readonly IndexedRepository[]
  connections: DataState<Connections>
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
  const rows = repositories.map((entry) => ({
    entry,
    cells: listCells(entry, linkedCell(connections, entry.repo), m),
  }))
  const header: ListCells = {
    name: m.columns.repo,
    state: m.columns.state,
    commit: m.columns.commit,
    files: m.columns.files,
    symbols: m.columns.symbols,
    size: m.columns.size,
    linked: m.columns.linked,
  }
  const width = (pick: (cells: ListCells) => string) =>
    Math.max(textWidth(pick(header)), ...rows.map(({ cells }) => textWidth(pick(cells))))
  const columns = {
    state: width((cells) => cells.state),
    commit: width((cells) => cells.commit),
    files: width((cells) => cells.files),
    symbols: width((cells) => cells.symbols),
    size: width((cells) => cells.size),
    linked: width((cells) => cells.linked),
  }
  const fixed = Object.values(columns).reduce((sum, value) => sum + value, 0)
  const room = size.columns - 2 - fixed - GAP.length * Object.keys(columns).length
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
      cells.linked.padStart(columns.linked),
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

function linkedCell(state: DataState<Connections>, repo: string): string {
  if (state.status === 'loading') return '…'
  const entry = connectionsOf(state, repo)
  if (entry === undefined) return NO_VALUE
  if (entry.declared.status === 'invalid') return '!'
  const { related } = entry.declared
  if (related.length === 0) return NO_VALUE
  if (entry.source.state !== 'read') return `?/${related.length}`
  const linked = related.filter(({ link }) => link.state === 'linked').length
  return `${linked}/${related.length}`
}

function listCells(
  { repo, index }: IndexedRepository,
  linked: string,
  m: GraphMessages,
): ListCells {
  const indexed = index.state === 'indexed' ? index : undefined
  return {
    name: oneLine(repo),
    state: m.states[index.state],
    commit: indexed === undefined ? NO_VALUE : shortSha(indexed.snapshot.sha),
    files: indexed === undefined ? NO_VALUE : m.amount(indexed.summary.files.indexed),
    symbols: indexed === undefined ? NO_VALUE : m.amount(symbolTotal(indexed.summary.symbols)),
    size:
      index.state === 'missing' || index.state === 'unreadable' ? NO_VALUE : bytesText(index.bytes),
    linked,
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

function RepositoryView({
  entry,
  connections,
  tail,
}: {
  entry: IndexedRepository
  connections: DataState<Connections>
  tail: readonly ReactNode[]
}) {
  const messages = useMessages()
  const theme = useTheme()
  const { now, home } = useAppDeps()
  const size = useScreenSize()
  const draw: DrawContext = { messages, theme, width: size.columns }
  const lines: ReactNode[] = [
    <Text bold>{oneLine(entry.repo)}</Text>,
    ...section(messages.graph.detail.index, indexLines(entry.index, draw, home, now())),
    ...section(
      messages.graph.connections.title,
      connectionLines(connections, entry.repo, { ...draw, width: size.columns - 2 }),
    ),
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
              `${shortSha(snapshot.sha)} · ${snapshot.defaultBranch ? d.defaultBranch : oneLine(snapshot.ref)}`,
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

function connectionLines(
  state: DataState<Connections>,
  repo: string,
  draw: DrawContext,
): ReactNode[] {
  const { messages, theme, width } = draw
  const { colors } = theme
  const c = messages.graph.connections
  if (state.status === 'loading') return indented(textLines(messages.loading, width, colors.dim))
  if (state.status === 'failed') return indented(failedNodes(draw, state.error))
  const entry = connectionsOf(state, repo)
  if (entry?.declared.status === 'invalid') {
    return indented(failedNodes(draw, entry.declared.error))
  }
  const declared = entry?.declared
  const lines: ReactNode[] = [
    ...(entry?.source.state === 'not-indexed'
      ? textLines(c.sourceNotIndexed(notIndexedText(entry.source.why, c)), width, colors.warn)
      : []),
    ...(declared?.configError == null
      ? []
      : textLines(c.configError(oneLine(declared.configError)), width, colors.warn)),
    ...(declared?.warnings ?? []).flatMap((warning) =>
      textLines(oneLine(warning), width, colors.dim),
    ),
  ]
  const related = declared?.related ?? []
  if (related.length === 0) {
    lines.push(...textLines(c.none, width), ...textLines(c.declareHint, width, colors.dim))
  }
  for (const connection of related) lines.push(...relatedLines(connection, repo, draw))
  return indented(lines)
}

function relatedLines(connection: Connection, repo: string, draw: DrawContext): ReactNode[] {
  const { messages, theme, width } = draw
  const { colors } = theme
  const c = messages.graph.connections
  const { link } = connection
  const [label, color] =
    link.state === 'linked'
      ? [c.linked, colors.ok]
      : link.state === 'no-link'
        ? [c.noLink, colors.dim]
        : link.state === 'unknown'
          ? [c.unknown, colors.dim]
          : [c.notIndexed(notIndexedText(link.why, c)), colors.warn]
  const head = [
    oneLine(connection.repo),
    label,
    ...(connection.description === undefined ? [] : [oneLine(connection.description)]),
  ].join(' · ')
  const lines = textLines(head, width, color)
  if (link.state !== 'linked') return lines
  const branches = [
    ...byEcosystem(link.publishes).map(([ecosystem, names]) =>
      c.publishes(
        oneLine(repo),
        namesText(names, PACKAGES_SHOWN),
        c.ecosystems[ecosystem],
        oneLine(connection.repo),
        names.length,
      ),
    ),
    ...byEcosystem(link.uses).map(([ecosystem, names]) =>
      c.publishes(
        oneLine(connection.repo),
        namesText(names, PACKAGES_SHOWN),
        c.ecosystems[ecosystem],
        oneLine(repo),
        names.length,
      ),
    ),
  ]
  branches.forEach((text, position) => {
    const last = position === branches.length - 1
    wrapText(text, width - BRANCH_INDENT - 2).forEach((line, row) => {
      const mark = row > 0 ? (last ? ' ' : '│') : last ? '└' : '├'
      lines.push(
        <Text color={colors.soft}>
          {' '.repeat(BRANCH_INDENT)}
          {mark} {line}
        </Text>,
      )
    })
  })
  return lines
}

function byEcosystem(packages: readonly PackageRef[]): [PackageRef['ecosystem'], string[]][] {
  const groups = new Map<PackageRef['ecosystem'], string[]>()
  for (const { ecosystem, name } of packages) {
    groups.set(ecosystem, [...(groups.get(ecosystem) ?? []), name])
  }
  return [...groups]
}
