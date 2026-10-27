import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { useState } from 'react'
import type { ListedRun, RunRecord } from '../../app/read-history.js'
import type {
  ListedRepository,
  RepositoryDetail,
  RepositoryIndex,
  RepositoryList,
  RepositoryOrigin,
} from '../../app/read-repositories.js'
import type { UserRepoFile } from '../../config/user-config.js'
import {
  useAppDeps,
  useBack,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useScreenSize,
  useTheme,
} from '../app-context.js'
import { configChangeLines, useConfigChange } from '../config-change.js'
import { usePolled } from '../data-hooks.js'
import { DataView, failedLines, failedText } from '../data-view.js'
import { useHandOff } from '../hand-off.js'
import type { HandOffOutcome } from '../hand-off.js'
import type { UiMessages } from '../i18n/messages.js'
import { labeledLines } from '../labeled-lines.js'
import { absoluteTime, relativeTime } from '../relative-time.js'
import { RepositoryPicker } from '../repository-picker.js'
import { verdictColor, verdictLabel } from '../run-text.js'
import { ScrollList, ScrollText, useSelection } from '../scroll-list.js'
import { indented, ruleLines, settingLines } from '../setting-lines.js'
import { SubView } from '../sub-view.js'
import { textWidth } from '../tab-layout.js'
import type { Theme } from '../theme.js'
import { fit, oneLine, shortenHome, wrapText } from '../text-fit.js'
import { bytesText } from '../units.js'

const GAP = '  '
const MIN_NAME_WIDTH = 16
const SHORT_SHA = 7

const repoKey = ({ repo }: ListedRepository) => repo

export function RepositoriesScreen() {
  const messages = useMessages()
  const [adding, setAdding] = useState(false)
  const m = messages.repositories.edit
  if (adding) {
    return (
      <SubView onLeave={() => setAdding(false)}>
        <RepositoryPicker intro={m.addIntro} noToken={m.noToken} onSaved={() => setAdding(false)} />
      </SubView>
    )
  }
  return <RepositoryBrowser onAdd={() => setAdding(true)} />
}

function RepositoryBrowser({ onAdd }: { onAdd(): void }) {
  const { readRepositories, ensureRepositoryFile, home } = useAppDeps()
  const messages = useMessages()
  const theme = useTheme()
  const size = useScreenSize()
  const [round, setRound] = useState(0)
  const readAgain = () => setRound((current) => current + 1)
  const state = usePolled(readRepositories, undefined, String(round))
  const [open, setOpen] = useState<string | undefined>()
  const handOff = useHandOff()
  const [edited, setEdited] = useState<HandOffOutcome>()
  const change = useConfigChange(readAgain)
  const list = state.status === 'ready' ? state.value : undefined
  const repositories = list?.repositories ?? []
  const listing = open === undefined && list !== undefined
  const selection = useSelection(repositories, repoKey, {
    active: open === undefined && !change.open,
    onOpen: (entry) => setOpen(entry.repo),
  })
  const item = listing ? selection.item : undefined
  const configEditable = listing && list.configError === null
  const watched = item?.origins.includes('watched') ?? false
  const publishes = item?.publish === 'pr'

  const editFile = async (repo: string, file: UserRepoFile) => {
    setEdited(undefined)
    let outcome: HandOffOutcome | undefined
    try {
      outcome = await handOff.run({ kind: 'editor', file: await ensureRepositoryFile(repo, file) })
    } catch (error) {
      outcome = { kind: 'failed', error }
    }
    if (outcome === undefined) return
    readAgain()
    setEdited(outcome)
  }

  useBack(change.open ? change.cancel : open === undefined ? undefined : () => setOpen(undefined))
  useScreenInput((input) => {
    if (!listing || change.open || handOff.running) return
    if (configEditable && input === 'a') return onAdd()
    if (item === undefined) return
    if (configEditable && input === 'w') {
      return change.propose([{ kind: watched ? 'unwatch' : 'watch', repo: item.repo }])
    }
    if (configEditable && watched && input === 'p') {
      return change.propose([{ kind: 'publish', repo: item.repo, publish: !publishes }])
    }
    if (input === 'e') void editFile(item.repo, 'config.yml')
    if (input === 'R') void editFile(item.repo, 'rules.md')
  })
  const e = messages.repositories.edit
  useScreenKeys(
    open !== undefined
      ? [
          { keys: '↑/↓', label: messages.list.scroll },
          { keys: 'Esc', label: messages.keys.back },
        ]
      : change.open
        ? change.keys
        : [
            ...(repositories.length === 0
              ? []
              : [
                  { keys: '↑/↓', label: messages.keys.select },
                  { keys: 'Enter', label: messages.keys.open },
                ]),
            ...(configEditable && item !== undefined
              ? [{ keys: 'w', label: watched ? e.unwatch : e.watch }]
              : []),
            ...(configEditable && watched
              ? [{ keys: 'p', label: publishes ? e.publishOff : e.publishOn }]
              : []),
            ...(configEditable ? [{ keys: 'a', label: e.add }] : []),
            ...(item === undefined
              ? []
              : [
                  { keys: 'e', label: e.config },
                  { keys: 'R', label: e.rules },
                ]),
          ],
  )
  if (open !== undefined) return <RepositoryDetailView repo={open} />
  const draw = { messages, theme, home, width: size.columns }
  const tail = [
    ...(edited === undefined ? [] : editorOutcomeLines(edited, messages, theme)),
    ...configChangeLines(change.state, draw),
  ]
  return (
    <DataView state={state}>
      {(loaded) => (
        <RepositoryListView
          list={loaded}
          selected={selection.index}
          tail={tail.length === 0 ? [] : [<Text> </Text>, ...tail]}
        />
      )}
    </DataView>
  )
}

function editorOutcomeLines(
  outcome: HandOffOutcome,
  messages: UiMessages,
  { colors }: Theme,
): ReactNode[] {
  switch (outcome.kind) {
    case 'exited':
      return outcome.exitCode === 0
        ? []
        : [
            <Text color={colors.warn}>
              {messages.repositories.edit.editorFailed(outcome.exitCode)}
            </Text>,
          ]
    case 'not-found':
      return [
        <Text color={colors.warn}>{messages.handOff.notFound(oneLine(outcome.command))}</Text>,
      ]
    case 'failed':
      return [<Text color={colors.error}>{failedText(messages, outcome.error)}</Text>]
  }
}

function RepositoryListView({
  list,
  selected,
  tail,
}: {
  list: RepositoryList
  selected: number
  tail: readonly ReactNode[]
}) {
  const messages = useMessages()
  const theme = useTheme()
  const { colors } = theme
  const { now } = useAppDeps()
  const size = useScreenSize()
  const m = messages.repositories
  const time = now()
  const rows = list.repositories.map((entry) => ({
    entry,
    name: oneLine(entry.repo),
    origins: originsText(entry.origins, messages),
    indexText: entry.index.file === null ? m.noIndex : bytesText(entry.index.file.bytes),
    last: entry.lastReview === null ? '–' : lastReviewText(entry.lastReview, time, messages),
  }))
  const width = (header: string, values: readonly string[]) =>
    Math.max(textWidth(header), ...values.map(textWidth))
  const fullOrigins = width(
    m.columns.origin,
    rows.map(({ origins }) => origins),
  )
  const index = width(
    m.columns.index,
    rows.map(({ indexText }) => indexText),
  )
  const last = width(
    m.columns.last,
    rows.map(({ last: text }) => text),
  )
  const room = Math.max(size.columns - 2 - index - last - GAP.length * 3, 0)
  const leastOrigins = Math.min(
    fullOrigins,
    Math.max(textWidth(m.columns.origin), ...Object.values(m.origins).map(textWidth)),
  )
  const nameWidth = Math.min(
    width(
      m.columns.repo,
      rows.map(({ name }) => name),
    ),
    Math.max(room - leastOrigins, MIN_NAME_WIDTH),
  )
  const columns = {
    origins: Math.max(Math.min(fullOrigins, room - nameWidth), 0),
    index,
    last,
  }
  const line = (cells: { name: string; origins: string; indexText: string; last: string }) =>
    [
      fit(cells.name, nameWidth, 'start'),
      fit(cells.origins, columns.origins),
      fit(cells.indexText, columns.index),
      cells.last,
    ].join(GAP)
  const watched = list.repositories.filter(({ origins }) => origins.includes('watched')).length
  const head: ReactNode[] = [
    ...(list.configError === null
      ? []
      : failedLines(messages, list.configError, size.columns).map((line) => (
          <Text color={colors.error}>{line}</Text>
        ))),
    ...(rows.length === 0
      ? []
      : [<Text bold>{`${m.count(rows.length)} · ${m.watched(watched)}`}</Text>]),
  ]
  return (
    <Box flexDirection="column" width={size.columns}>
      {head.map((node, position) => (
        <Text key={position} wrap="truncate-end">
          {node}
        </Text>
      ))}
      {rows.length === 0 ? (
        list.configError === null && <EmptyRepositories list={list} />
      ) : (
        <>
          <Text color={colors.dim} wrap="truncate-end">
            {'  '}
            {line({
              name: m.columns.repo,
              origins: m.columns.origin,
              indexText: m.columns.index,
              last: m.columns.last,
            })}
          </Text>
          <ScrollList
            items={rows}
            index={selected}
            rows={Math.max(size.rows - head.length - 1 - tail.length, 1)}
            keyOf={({ entry }) => repoKey(entry)}
            renderItem={(row) => (
              <>
                {fit(row.name, nameWidth, 'start')}
                {GAP}
                {fit(row.origins, columns.origins)}
                {GAP}
                <Text color={row.entry.index.file === null ? colors.dim : undefined}>
                  {fit(row.indexText, columns.index)}
                </Text>
                {GAP}
                <Text color={verdictColor(row.entry.lastReview, theme)}>{row.last}</Text>
              </>
            )}
          />
        </>
      )}
      {tail.map((node, position) => (
        <Text key={`tail-${position}`} wrap="truncate-end">
          {node}
        </Text>
      ))}
    </Box>
  )
}

function EmptyRepositories({ list }: { list: RepositoryList }) {
  const messages = useMessages()
  const { home } = useAppDeps()
  const { colors } = useTheme()
  const command = (text: string) => (
    <Text bold color={colors.accent}>
      {text}
    </Text>
  )
  if (!list.configured) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text>{messages.settings.noConfig}</Text>
        <Text color={colors.dim}>
          {messages.settings.initHint} {command('phada setup')}
        </Text>
      </Box>
    )
  }
  const m = messages.repositories
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{m.nothingWatched}</Text>
      <Text color={colors.dim}>
        {m.nothingWatchedHint(oneLine(shortenHome(list.configFile, home)))} {command('phada watch')}
      </Text>
      <Text color={colors.dim}>
        {m.then} {command('phada review owner/repo#N')}
      </Text>
    </Box>
  )
}

function RepositoryDetailView({ repo }: { repo: string }) {
  const { readRepository } = useAppDeps()
  const state = usePolled(() => readRepository(repo), undefined, repo)
  return <DataView state={state}>{(detail) => <RepositoryDetailLines detail={detail} />}</DataView>
}

function RepositoryDetailLines({ detail }: { detail: RepositoryDetail }) {
  const messages = useMessages()
  const theme = useTheme()
  const { colors } = theme
  const { now, home } = useAppDeps()
  const size = useScreenSize()
  const d = messages.repositories.detail
  const time = now()
  const section = (heading: string, lines: ReactNode[]) => [
    <Text> </Text>,
    <Text bold>{heading}</Text>,
    ...lines,
  ]
  const note = (text: string, color = colors.dim) =>
    wrapText(text, size.columns - 2).map((line) => <Text color={color}>{`  ${line}`}</Text>)
  const origins = detail.origins.length === 0 ? '' : ` · ${originsText(detail.origins, messages)}`
  const lines: ReactNode[] = [
    <Text bold>
      {oneLine(detail.repo)}
      <Text color={colors.soft}>{origins}</Text>
    </Text>,
    ...section(d.watch, watchLines(detail, home, messages, colors.soft, size.columns)),
    ...section(
      d.index,
      indexLines(detail.repo, detail.index, home, time, messages, theme, size.columns),
    ),
    ...section(
      d.config,
      detail.config.status === 'invalid'
        ? note(failedText(messages, detail.config.error), colors.error)
        : [
            ...settingLines(detail.config.settings, messages, theme, size.columns),
            ...detail.config.warnings.flatMap((warning) => note(warning, colors.warn)),
          ],
    ),
    ...(detail.config.status === 'read' && detail.config.rules.length > 0
      ? section(
          d.rules(detail.config.rules.length),
          ruleLines(detail.config.rules, messages, theme, size.columns),
        )
      : []),
    <Text> </Text>,
    ...note(d.repositoryCanChange),
    ...section(
      d.related,
      detail.related.length === 0
        ? note(d.noRelated)
        : detail.related.map((related) => (
            <Text>
              {'  '}
              {oneLine(related.repo)}
              {related.description === undefined ? '' : ` — ${oneLine(related.description)}`}
              {GAP}
              <Text color={colors.dim}>{messages.settings.origins[related.origin]}</Text>
            </Text>
          )),
    ),
    ...section(
      detail.reviews.total === 0
        ? d.reviews(0, 0)
        : d.reviews(detail.reviews.runs.length, detail.reviews.total),
      detail.reviews.runs.length === 0
        ? note(d.noReviews)
        : reviewLines(detail.reviews.runs, time, messages, theme),
    ),
  ]
  return <ScrollText lines={lines} rows={size.rows} />
}

function watchLines(
  detail: RepositoryDetail,
  home: string,
  messages: UiMessages,
  labelColor: string | undefined,
  columns: number,
): ReactNode[] {
  const d = messages.repositories.detail
  const { watch } = detail
  if (watch === null) {
    return wrapText(d.notWatched(oneLine(shortenHome(detail.configFile, home))), columns - 2).map(
      (line) => <Text>{`  ${line}`}</Text>,
    )
  }
  const names = (values: readonly string[] | undefined) =>
    values === undefined || values.length === 0 ? undefined : values.map(oneLine).join(', ')
  return indented(
    labeledLines(
      [
        [d.publish, messages.requests.publish[watch.publish]],
        [d.authors, names(watch.authors)],
        [d.labels, names(watch.labels)],
        [d.baseBranches, names(watch.baseBranches)],
        [d.external, watch.allowExternal ? d.externalAllowed : d.externalRefused],
        [d.when, watch.when === undefined ? undefined : oneLine(watch.when)],
      ],
      columns - 2,
      labelColor,
    ),
  )
}

function indexLines(
  repo: string,
  index: RepositoryIndex,
  home: string,
  now: Date,
  messages: UiMessages,
  { colors }: Theme,
  columns: number,
): ReactNode[] {
  const d = messages.repositories.detail
  if (index.file === null) {
    return [
      <Text>
        {'  '}
        {d.noIndex}{' '}
        <Text bold color={colors.accent}>
          {`phada index ${oneLine(repo)}`}
        </Text>
      </Text>,
    ]
  }
  const commit =
    index.indexedSha === null
      ? undefined
      : [
          index.indexedSha.slice(0, SHORT_SHA),
          ...(index.checkedAt === null
            ? []
            : [
                `${d.checked(relativeTime(index.checkedAt, now, messages.time))} (${absoluteTime(index.checkedAt)})`,
              ]),
        ].join(' · ')
  return indented(
    labeledLines(
      [
        [d.file, `${oneLine(shortenHome(index.file.path, home))} · ${bytesText(index.file.bytes)}`],
        [d.commit, commit],
      ],
      columns - 2,
      colors.soft,
    ),
  )
}

function reviewLines(
  runs: readonly ListedRun[],
  now: Date,
  messages: UiMessages,
  theme: Theme,
): ReactNode[] {
  const cells = runs.map((run) => ({
    run,
    number: `#${run.number}`,
    verdict: verdictLabel(run, messages),
    score: run.score === undefined ? '–' : `${run.score}/5`,
    when: relativeTime(run.startedAt, now, messages.time),
  }))
  const width = (values: readonly string[]) => Math.max(0, ...values.map(textWidth))
  const columns = {
    number: width(cells.map(({ number }) => number)),
    verdict: width(cells.map(({ verdict }) => verdict)),
    score: width(cells.map(({ score }) => score)),
    when: width(cells.map(({ when }) => when)),
  }
  return cells.map((cell) => (
    <Text>
      {'  '}
      {fit(cell.number, columns.number)}
      {GAP}
      <Text color={verdictColor(cell.run, theme)}>{fit(cell.verdict, columns.verdict)}</Text>
      {GAP}
      {fit(cell.score, columns.score)}
      {GAP}
      <Text color={theme.colors.dim}>{fit(cell.when, columns.when)}</Text>
      {GAP}
      {oneLine(cell.run.title ?? '')}
    </Text>
  ))
}

function originsText(origins: readonly RepositoryOrigin[], messages: UiMessages): string {
  return origins.map((origin) => messages.repositories.origins[origin]).join(', ')
}

function lastReviewText(run: RunRecord, now: Date, messages: UiMessages): string {
  return `${verdictLabel(run, messages)} · ${relativeTime(run.startedAt, now, messages.time)}`
}
