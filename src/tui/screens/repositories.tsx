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
import {
  useAppDeps,
  useBack,
  useMessages,
  useScreenKeys,
  useScreenSize,
  useTheme,
} from '../app-context.js'
import { usePolled } from '../data-hooks.js'
import { DataView } from '../data-view.js'
import type { UiMessages } from '../i18n/messages.js'
import { labeledLines } from '../labeled-lines.js'
import { absoluteTime, relativeTime } from '../relative-time.js'
import { ScrollList, ScrollText, useSelection } from '../scroll-list.js'
import { settingLines } from '../setting-lines.js'
import { textWidth } from '../tab-layout.js'
import type { Theme } from '../theme.js'
import { fit, oneLine, wrapText } from '../text-fit.js'
import { bytesText } from '../units.js'

const GAP = '  '
const MIN_NAME_WIDTH = 16
const SHORT_SHA = 7

const repoKey = ({ repo }: ListedRepository) => repo

export function RepositoriesScreen() {
  const { readRepositories } = useAppDeps()
  const messages = useMessages()
  const state = usePolled(readRepositories)
  const [open, setOpen] = useState<string | undefined>()
  const repositories = state.status === 'ready' ? state.value.repositories : []
  const selection = useSelection(repositories, repoKey, {
    active: open === undefined,
    onOpen: (entry) => setOpen(entry.repo),
  })
  useBack(open === undefined ? undefined : () => setOpen(undefined))
  useScreenKeys(
    open === undefined
      ? repositories.length === 0
        ? []
        : [
            { keys: '↑/↓', label: messages.keys.select },
            { keys: 'Enter', label: messages.keys.open },
          ]
      : [
          { keys: '↑/↓', label: messages.list.scroll },
          { keys: 'Esc', label: messages.keys.back },
        ],
  )
  if (open !== undefined) return <RepositoryDetailView repo={open} />
  return (
    <DataView state={state}>
      {(list) => <RepositoryListView list={list} index={selection.index} />}
    </DataView>
  )
}

function RepositoryListView({ list, index }: { list: RepositoryList; index: number }) {
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
    index: entry.index.file === null ? m.noIndex : bytesText(entry.index.file.bytes),
    last: entry.lastReview === null ? '–' : lastReviewText(entry.lastReview, time, messages),
  }))
  const width = (header: string, values: readonly string[]) =>
    Math.max(textWidth(header), ...values.map(textWidth))
  const columns = {
    origins: width(
      m.columns.origin,
      rows.map(({ origins }) => origins),
    ),
    index: width(
      m.columns.index,
      rows.map(({ index: text }) => text),
    ),
    last: width(
      m.columns.last,
      rows.map(({ last }) => last),
    ),
  }
  const fixed = 2 + columns.origins + columns.index + columns.last + GAP.length * 3
  const nameWidth = Math.min(
    width(
      m.columns.repo,
      rows.map(({ name }) => name),
    ),
    Math.max(size.columns - fixed, MIN_NAME_WIDTH),
  )
  const line = (cells: { name: string; origins: string; index: string; last: string }) =>
    [
      fit(cells.name, nameWidth, 'start'),
      fit(cells.origins, columns.origins),
      fit(cells.index, columns.index),
      cells.last,
    ].join(GAP)
  const watched = list.repositories.filter(({ origins }) => origins.includes('watched')).length
  const head: ReactNode[] = [
    ...(list.configError === null
      ? []
      : [<Text color={colors.error}>{oneLine(messages.settings.invalid(list.configError))}</Text>]),
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
        <EmptyRepositories list={list} />
      ) : (
        <>
          <Text color={colors.dim} wrap="truncate-end">
            {'  '}
            {line({
              name: m.columns.repo,
              origins: m.columns.origin,
              index: m.columns.index,
              last: m.columns.last,
            })}
          </Text>
          <ScrollList
            items={rows}
            index={index}
            rows={Math.max(size.rows - head.length - 1, 1)}
            keyOf={({ entry }) => repoKey(entry)}
            renderItem={(row) => (
              <>
                {fit(row.name, nameWidth, 'start')}
                {GAP}
                {fit(row.origins, columns.origins)}
                {GAP}
                <Text color={row.entry.index.file === null ? colors.dim : undefined}>
                  {fit(row.index, columns.index)}
                </Text>
                {GAP}
                <Text color={verdictColor(row.entry.lastReview, theme)}>{row.last}</Text>
              </>
            )}
          />
        </>
      )}
    </Box>
  )
}

function EmptyRepositories({ list }: { list: RepositoryList }) {
  const messages = useMessages()
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
          {messages.settings.initHint} {command('phada init --global')}
        </Text>
      </Box>
    )
  }
  const m = messages.repositories
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{m.nothingWatched}</Text>
      <Text color={colors.dim}>
        {m.nothingWatchedHint(oneLine(list.configFile))} {command('phada watch')}
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
  const { now } = useAppDeps()
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
    ...section(d.watch, watchLines(detail, messages, colors.soft, size.columns)),
    ...section(d.index, indexLines(detail.repo, detail.index, time, messages, theme, size.columns)),
    ...section(
      d.config,
      detail.config.status === 'invalid'
        ? note(messages.settings.invalid(detail.config.error), colors.error)
        : [
            ...settingLines(detail.config.settings, messages, theme, size.columns),
            ...detail.config.warnings.flatMap((warning) => note(warning, colors.warn)),
          ],
    ),
    ...(detail.config.status === 'read' && detail.config.rules.length > 0
      ? section(
          d.rules(detail.config.rules.length),
          detail.config.rules.map((rule) => (
            <Text>
              {'  '}
              <Text color={colors.soft}>{oneLine(rule.key)}</Text>
              {GAP}
              {oneLine(rule.text)}
              {GAP}
              <Text color={colors.dim}>{messages.settings.origins[rule.origin]}</Text>
            </Text>
          )),
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
  messages: UiMessages,
  labelColor: string | undefined,
  columns: number,
): ReactNode[] {
  const d = messages.repositories.detail
  const { watch } = detail
  if (watch === null) {
    return wrapText(d.notWatched(oneLine(detail.configFile)), columns - 2).map((line) => (
      <Text>{`  ${line}`}</Text>
    ))
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
        [d.file, `${oneLine(index.file.path)} · ${bytesText(index.file.bytes)}`],
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
    verdict: verdictText(run, messages),
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

function indented(lines: ReactNode[]): ReactNode[] {
  return lines.map((line) => (
    <Text>
      {'  '}
      {line}
    </Text>
  ))
}

function originsText(origins: readonly RepositoryOrigin[], messages: UiMessages): string {
  return origins.map((origin) => messages.repositories.origins[origin]).join(', ')
}

function lastReviewText(run: RunRecord, now: Date, messages: UiMessages): string {
  return `${verdictText(run, messages)} · ${relativeTime(run.startedAt, now, messages.time)}`
}

function verdictText(run: RunRecord, messages: UiMessages): string {
  return run.verdict === undefined
    ? messages.reviews.statuses[run.status]
    : messages.reviews.verdicts[run.verdict]
}

function verdictColor(run: RunRecord | null, { colors }: Theme): string | undefined {
  const verdict = run?.verdict ?? (run?.status === 'failed' ? 'failed' : undefined)
  if (verdict === 'clean') return colors.ok
  if (verdict === 'comments') return colors.warn
  if (verdict === 'blocking' || verdict === 'failed') return colors.error
  return colors.dim
}
