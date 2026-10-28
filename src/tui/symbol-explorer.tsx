import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import type {
  CallerList,
  CallerSite,
  DefinitionList,
  DependencyEntry,
  DependencyList,
  Explored,
  ExploredSymbol,
} from '../app/explore-graph.js'
import {
  useAppDeps,
  useArrowKeys,
  useBack,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useScreenSize,
  useTheme,
  useWorking,
} from './app-context.js'
import type { KeyHint } from './app-context.js'
import { useLoaded } from './data-hooks.js'
import type { DataState } from './data-hooks.js'
import { failedText } from './data-view.js'
import { failedNodes, spaced, textLines } from './frame-lines.js'
import type { DrawContext } from './frame-lines.js'
import type { ExploreMessages, UiMessages } from './i18n/messages.js'
import { notIndexedText } from './not-indexed-text.js'
import { useRepositoryIndexing } from './repository-indexing.js'
import { ScrollList, useSelection } from './scroll-list.js'
import { textWidth } from './tab-layout.js'
import { fit, namesText, oneLine } from './text-fit.js'
import { shortSha } from './refs.js'

const INDENT = '  '
const MAX_LOCATION_WIDTH = 36
const LINKED_SHOWN = 3
const ROW_MARK = 2

type Level = { kind: 'callers' | 'dependencies'; of: ExploredSymbol }

type TreeItem =
  | { type: 'branch'; level: Level }
  | { type: 'caller'; site: CallerSite }
  | { type: 'dependency'; entry: DependencyEntry }

type LevelItems =
  | { state: 'read'; items: TreeItem[]; more: number; capped: boolean }
  | Extract<Explored<unknown>, { state: 'not-indexed' }>

type Row =
  | { type: 'node'; key: string; depth: number; item: TreeItem; open?: DataState<LevelItems> }
  | { type: 'note'; key: string; depth: number; text: string; tone: 'dim' | 'warn' | 'error' }

export function SymbolExplorer({ repo, name }: { repo: string; name: string }) {
  const { searchSymbol } = useAppDeps()
  const messages = useMessages()
  const size = useScreenSize()
  const searched = useLoaded(`graph-search:${repo}:${name}`, () => searchSymbol(repo, name))
  const indexing = useRepositoryIndexing(() => searched.reload())
  const [picked, setPicked] = useState<string | undefined>()
  const state = searched.state
  const found = state.status === 'ready' && state.value.state === 'read' ? state.value : undefined
  const definitions = found?.result.definitions ?? []
  const single = definitions.length === 1 ? definitions[0] : undefined
  const chosen = single ?? definitions.find((symbol) => symbolKey(symbol) === picked)
  const offersIndex =
    state.status === 'ready' && (state.value.state === 'not-indexed' || definitions.length === 0)

  useBack(
    indexing.busy
      ? indexing.stop
      : chosen !== undefined && single === undefined
        ? () => setPicked(undefined)
        : undefined,
  )
  useScreenInput((input) => {
    if (input === 'i' && offersIndex) indexing.start([repo])
  })

  const tail = spaced(indexing.lines(size.columns))
  const indexKeys: KeyHint[] = indexing.busy
    ? indexing.keys
    : offersIndex
      ? [
          {
            keys: 'i',
            label:
              state.status === 'ready' && state.value.state === 'not-indexed'
                ? messages.indexing.index
                : messages.indexing.again,
          },
        ]
      : []

  if (found !== undefined && chosen !== undefined) {
    return (
      <SymbolTree
        key={symbolKey(chosen)}
        repo={repo}
        root={chosen}
        linked={found.linked}
        hasBack={single === undefined}
        tail={tail}
      />
    )
  }
  if (found !== undefined && definitions.length > 1) {
    return (
      <DefinitionPicker
        repo={repo}
        name={name}
        list={found.result}
        onPick={(symbol) => setPicked(symbolKey(symbol))}
        tail={tail}
      />
    )
  }
  return (
    <SearchState
      repo={repo}
      name={name}
      state={state}
      commit={found?.commit}
      keys={indexKeys}
      tail={tail}
    />
  )
}

function SearchState({
  repo,
  name,
  state,
  commit,
  keys,
  tail,
}: {
  repo: string
  name: string
  state: DataState<Explored<DefinitionList>>
  commit: string | undefined
  keys: KeyHint[]
  tail: readonly ReactNode[]
}) {
  const messages = useMessages()
  const m = messages.graph.explore
  const theme = useTheme()
  const size = useScreenSize()
  const draw: DrawContext = { messages, theme, width: size.columns }
  const { colors } = theme
  useScreenKeys([...keys, { keys: 'r', label: messages.keys.refresh }])
  const lines: ReactNode[] =
    state.status === 'loading'
      ? textLines(m.searching(oneLine(name)), size.columns, colors.dim)
      : state.status === 'failed'
        ? failedNodes(draw, state.error)
        : state.value.state === 'not-indexed'
          ? textLines(
              m.cannotExplore(
                oneLine(repo),
                notIndexedText(state.value.why, messages.graph.connections),
              ),
              size.columns,
              colors.warn,
            )
          : [
              ...textLines(
                m.notFound(oneLine(name), oneLine(repo), shortSha(commit ?? '')),
                size.columns,
              ),
              ...textLines(m.notFoundHint, size.columns, colors.dim),
            ]
  return <LinesBox lines={[...lines, ...tail]} />
}

function DefinitionPicker({
  repo,
  name,
  list,
  onPick,
  tail,
}: {
  repo: string
  name: string
  list: DefinitionList
  onPick(symbol: ExploredSymbol): void
  tail: readonly ReactNode[]
}) {
  const messages = useMessages()
  const { colors } = useTheme()
  const size = useScreenSize()
  const m = messages.graph.explore
  const selection = useSelection(list.definitions, symbolKey, { onOpen: onPick })
  useScreenKeys([
    { keys: '↑/↓', label: messages.keys.select },
    { keys: 'Enter', label: m.keys.explore },
    { keys: 'r', label: messages.keys.refresh },
  ])
  const width = size.columns - ROW_MARK
  const kindWidth = Math.max(...list.definitions.map((symbol) => textWidth(m.kinds[symbol.kind])))
  const locationWidth = Math.min(
    Math.max(...list.definitions.map((symbol) => textWidth(location(symbol, repo)))),
    MAX_LOCATION_WIDTH,
  )
  const signatureWidth = Math.max(width - kindWidth - locationWidth - INDENT.length * 2, 1)
  const row = (symbol: ExploredSymbol) =>
    [
      fit(m.kinds[symbol.kind], kindWidth),
      fit(location(symbol, repo), locationWidth, 'start'),
      fit(oneLine(symbol.signature), signatureWidth),
    ].join(INDENT)
  const footer = [
    ...(list.more === 0 ? [] : [<Text color={colors.dim}>{`${INDENT}${m.more(list.more)}`}</Text>]),
    ...tail,
  ]
  return (
    <Box flexDirection="column" width={size.columns}>
      <Text bold wrap="truncate-end">
        {m.definitions(list.definitions.length, oneLine(name))}
      </Text>
      <ScrollList
        items={list.definitions}
        index={selection.index}
        rows={Math.max(size.rows - 1 - footer.length, 1)}
        keyOf={symbolKey}
        renderItem={row}
      />
      {footer.map((node, position) => (
        <Text key={`footer-${position}`} wrap="truncate-end">
          {node}
        </Text>
      ))}
    </Box>
  )
}

function SymbolTree({
  repo,
  root,
  linked,
  hasBack,
  tail,
}: {
  repo: string
  root: ExploredSymbol
  linked: readonly string[]
  hasBack: boolean
  tail: readonly ReactNode[]
}) {
  const { symbolCallers, symbolDependencies } = useAppDeps()
  const messages = useMessages()
  const theme = useTheme()
  const size = useScreenSize()
  const m = messages.graph.explore
  const [opened, setOpened] = useState<ReadonlyMap<string, DataState<LevelItems>>>(new Map())
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )
  useWorking([...opened.values()].some((state) => state.status === 'loading'))
  useArrowKeys(true)

  const rows = treeRows(root, opened, m)
  const selection = useSelection(rows, (row) => row.key, { onOpen: (row) => expand(row) })

  const expand = (row: Row) => {
    if (row.type !== 'node' || opened.has(row.key)) return
    const level = levelOf(row.item)
    if (level === undefined) return
    const { key } = row
    const loading: DataState<LevelItems> = { status: 'loading' }
    setOpened((current) => new Map(current).set(key, loading))
    const read =
      level.kind === 'callers'
        ? symbolCallers(repo, level.of).then(callerItems)
        : symbolDependencies(repo, level.of).then(dependencyItems)
    read.then(
      (value) => settle(key, loading, { status: 'ready', value }),
      (error: unknown) => settle(key, loading, { status: 'failed', error }),
    )
  }

  const settle = (key: string, loading: DataState<LevelItems>, next: DataState<LevelItems>) => {
    if (!mounted.current) return
    setOpened((current) =>
      current.get(key) === loading ? new Map(current).set(key, next) : current,
    )
  }

  const collapse = (row: Row) => {
    const key = row.type === 'node' && opened.has(row.key) ? row.key : parentOf(row.key)
    if (key === undefined) return
    setOpened(
      (current) =>
        new Map([...current].filter(([open]) => open !== key && !open.startsWith(`${key}/`))),
    )
    selection.select(key)
  }

  useScreenInput((_input, key) => {
    const row = selection.item
    if (row === undefined) return
    if (key.rightArrow) expand(row)
    if (key.leftArrow) collapse(row)
  })
  useScreenKeys([
    { keys: '↑/↓', label: messages.keys.select },
    { keys: 'Enter/→', label: m.keys.expand },
    { keys: '←', label: m.keys.collapse },
    ...(hasBack ? [{ keys: 'Esc', label: messages.keys.back }] : []),
  ])

  const { colors } = theme
  const width = size.columns
  const prefix = `${m.kinds[root.kind]} ${oneLine(qualified(root))} · `
  const head: ReactNode[] = [
    <Text bold>
      {prefix}
      {fit(location(root, repo), Math.max(width - textWidth(prefix), 1), 'start')}
    </Text>,
    <Text color={colors.dim}>{fit(oneLine(root.signature), width)}</Text>,
    ...(linked.length === 0
      ? []
      : [
          <Text color={colors.dim}>
            {fit(m.crosses(namesText(linked.map(oneLine), LINKED_SHOWN)), width)}
          </Text>,
        ]),
    <Text> </Text>,
  ]
  const rowWidth = width - ROW_MARK
  return (
    <Box flexDirection="column" width={width}>
      {head.map((node, position) => (
        <Text key={`head-${position}`} wrap="truncate-end">
          {node}
        </Text>
      ))}
      <ScrollList
        items={rows}
        index={selection.index}
        rows={Math.max(size.rows - head.length - tail.length, 1)}
        keyOf={(row) => row.key}
        renderItem={(row) => rowNode(row, repo, rowWidth, messages, theme)}
      />
      {tail.map((node, position) => (
        <Text key={`tail-${position}`} wrap="truncate-end">
          {node}
        </Text>
      ))}
    </Box>
  )
}

function treeRows(
  root: ExploredSymbol,
  opened: ReadonlyMap<string, DataState<LevelItems>>,
  m: ExploreMessages,
): Row[] {
  const rows: Row[] = []
  const walk = (key: string, depth: number, item: TreeItem) => {
    const open = opened.get(key)
    rows.push({ type: 'node', key, depth, item, ...(open === undefined ? {} : { open }) })
    if (open === undefined || open.status === 'loading') return
    const note = (suffix: string, text: string, tone: 'dim' | 'warn' | 'error' = 'dim') =>
      rows.push({ type: 'note', key: `${key}/#${suffix}`, depth: depth + 1, text, tone })
    if (open.status === 'failed' || open.value.state === 'not-indexed') return
    const level = open.value
    if (level.items.length === 0) note('none', m.none)
    level.items.forEach((child, index) => walk(`${key}/${index}`, depth + 1, child))
    if (level.more > 0) note('more', m.more(level.more))
    if (level.capped) note('capped', m.capped, 'warn')
  }
  walk('callers', 0, { type: 'branch', level: { kind: 'callers', of: root } })
  walk('dependencies', 0, { type: 'branch', level: { kind: 'dependencies', of: root } })
  return rows
}

function rowNode(
  row: Row,
  repo: string,
  width: number,
  messages: UiMessages,
  theme: DrawContext['theme'],
): ReactNode {
  const { colors } = theme
  const indent = INDENT.repeat(row.depth)
  if (row.type === 'note') {
    const color =
      row.tone === 'warn' ? colors.warn : row.tone === 'error' ? colors.error : colors.dim
    return <Text color={color}>{fit(`${indent}  ${row.text}`, width)}</Text>
  }
  const m = messages.graph.explore
  const expandable = levelOf(row.item) !== undefined
  const mark = !expandable ? ' ' : row.open === undefined ? '▸' : '▾'
  const status =
    row.open?.status === 'loading'
      ? ` · ${m.loading}`
      : row.open?.status === 'failed'
        ? ` · ${failedText(messages, row.open.error)}`
        : row.open?.status === 'ready' && row.open.value.state === 'not-indexed'
          ? ` · ${notIndexedText(row.open.value.why, messages.graph.connections)}`
          : ''
  const color =
    row.open?.status === 'failed'
      ? colors.error
      : row.item.type === 'branch'
        ? undefined
        : crosses(row.item, repo)
          ? colors.accent
          : undefined
  return (
    <Text color={color} bold={row.item.type === 'branch'}>
      {fit(`${indent}${mark} ${itemText(row.item, repo, m)}${status}`, width)}
    </Text>
  )
}

function itemText(item: TreeItem, repo: string, m: ExploreMessages): string {
  switch (item.type) {
    case 'branch':
      return item.level.kind === 'callers' ? m.callers : m.dependencies
    case 'caller': {
      const { site } = item
      return [
        `${place(site.repo, repo)}${oneLine(site.path)}:${site.line}`,
        ...(site.in === undefined ? [] : [oneLine(qualified(site.in))]),
        ...howText(site.how, site.pullRequest, m),
      ].join(' · ')
    }
    case 'dependency': {
      const { entry } = item
      const head =
        entry.target === undefined
          ? oneLine(entry.name)
          : `${oneLine(entry.name)} → ${location(entry.target, repo)}`
      return [
        head,
        ...(entry.target === undefined && entry.module !== undefined
          ? [oneLine(entry.module)]
          : []),
        ...howText(entry.how, entry.pullRequest, m),
      ].join(' · ')
    }
  }
}

function howText(
  how: CallerSite['how'],
  pullRequest: number | undefined,
  m: ExploreMessages,
): string[] {
  if (how === 'inferred') return [m.inferred]
  if (how === 'observed') return [m.observed(pullRequest)]
  return []
}

function crosses(item: TreeItem, repo: string): boolean {
  if (item.type === 'caller') return item.site.repo !== repo
  if (item.type === 'dependency')
    return item.entry.target !== undefined && item.entry.target.repo !== repo
  return false
}

function levelOf(item: TreeItem): Level | undefined {
  switch (item.type) {
    case 'branch':
      return item.level
    case 'caller':
      return item.site.in === undefined ? undefined : { kind: 'callers', of: item.site.in }
    case 'dependency':
      return item.entry.target === undefined
        ? undefined
        : { kind: 'dependencies', of: item.entry.target }
  }
}

function callerItems(read: Explored<CallerList>): LevelItems {
  if (read.state === 'not-indexed') return read
  const { sites, more, capped } = read.result
  return { state: 'read', items: sites.map((site) => ({ type: 'caller', site })), more, capped }
}

function dependencyItems(read: Explored<DependencyList>): LevelItems {
  if (read.state === 'not-indexed') return read
  const { dependencies, more } = read.result
  return {
    state: 'read',
    items: dependencies.map((entry) => ({ type: 'dependency', entry })),
    more,
    capped: false,
  }
}

function parentOf(key: string): string | undefined {
  const at = key.lastIndexOf('/')
  return at < 0 ? undefined : key.slice(0, at)
}

function symbolKey(symbol: ExploredSymbol): string {
  return `${symbol.repo}:${symbol.path}:${symbol.id}`
}

function qualified(symbol: ExploredSymbol): string {
  return symbol.owner === undefined ? symbol.name : `${symbol.owner}.${symbol.name}`
}

function place(repo: string, explored: string): string {
  return repo === explored ? '' : `${oneLine(repo)}:`
}

function location(symbol: ExploredSymbol, explored: string): string {
  return `${place(symbol.repo, explored)}${oneLine(symbol.path)}:${symbol.line}`
}

function LinesBox({ lines }: { lines: readonly ReactNode[] }) {
  const size = useScreenSize()
  return (
    <Box flexDirection="column" width={size.columns}>
      {lines.slice(0, size.rows).map((line, position) => (
        <Text key={position} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  )
}
