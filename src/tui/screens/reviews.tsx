import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { useState } from 'react'
import type {
  FeedbackFinding,
  ListedRun,
  ReviewDetail,
  StoredFinding,
} from '../../app/read-history.js'
import {
  useAppDeps,
  useBack,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useScreenSize,
  useTheme,
} from '../app-context.js'
import { usePolled, POLL_MS } from '../data-hooks.js'
import { DataView } from '../data-view.js'
import type { ReviewSource, UiMessages } from '../i18n/messages.js'
import { labeledLines } from '../labeled-lines.js'
import { absoluteTime, relativeTime } from '../relative-time.js'
import { ScrollList, ScrollText, useSelection } from '../scroll-list.js'
import { textWidth } from '../tab-layout.js'
import { TextFieldLine, useTextField } from '../text-field.js'
import type { Theme } from '../theme.js'
import { fit, oneLine, wrapText } from '../text-fit.js'

export const REVIEWS_SHOWN = 200
const MIN_REF_WIDTH = 12
const REF_SHARE = 0.45
const PLACE_SHARE = 0.4
const GAP = '  '

const runKey = (run: ListedRun) => String(run.id ?? `${run.repo}#${run.number}@${run.startedAt}`)

export function ReviewsScreen() {
  const { readReviews } = useAppDeps()
  const messages = useMessages()
  const filter = useTextField()
  const text = filter.value.trim()
  const state = usePolled(
    () => readReviews(text === '' ? { limit: REVIEWS_SHOWN } : { text, limit: REVIEWS_SHOWN }),
    POLL_MS,
    text,
  )
  const [open, setOpen] = useState<number | undefined>()
  const runs = state.status === 'ready' ? state.value.runs : []
  const listing = open === undefined && !filter.focused
  const selection = useSelection(runs, runKey, {
    active: listing,
    onOpen: (run) => {
      if (run.id !== undefined) setOpen(run.id)
    },
  })
  useBack(open === undefined ? undefined : () => setOpen(undefined))
  useScreenInput((input) => {
    if (listing && input === 'f') filter.focus()
  })
  useScreenKeys(
    filter.focused
      ? [
          { keys: 'Enter', label: messages.field.apply },
          { keys: 'Esc', label: messages.field.cancel },
        ]
      : open === undefined
        ? [
            ...(runs.length === 0
              ? []
              : [
                  { keys: '↑/↓', label: messages.keys.select },
                  { keys: 'Enter', label: messages.keys.open },
                ]),
            { keys: 'f', label: messages.reviews.filter.toLowerCase() },
          ]
        : [
            { keys: '↑/↓', label: messages.list.scroll },
            { keys: 'Esc', label: messages.keys.back },
          ],
  )
  if (open !== undefined) return <ReviewDetailView id={open} />
  return (
    <DataView state={state}>
      {({ runs: shown, total }) => (
        <ReviewList
          runs={shown}
          total={total}
          index={selection.index}
          filter={<TextFieldLine label={messages.reviews.filter} field={filter} />}
          showFilter={filter.focused || filter.value !== ''}
          text={text}
        />
      )}
    </DataView>
  )
}

function ReviewList({
  runs,
  total,
  index,
  filter,
  showFilter,
  text,
}: {
  runs: readonly ListedRun[]
  total: number
  index: number
  filter: ReactNode
  showFilter: boolean
  text: string
}) {
  const messages = useMessages()
  const theme = useTheme()
  const { colors } = theme
  const { now } = useAppDeps()
  const size = useScreenSize()
  const m = messages.reviews
  const time = now()
  const rows = runs.map((run) => ({
    run,
    ref: oneLine(`${run.repo}#${run.number}`),
    title: oneLine(run.title ?? ''),
    verdict: verdictLabel(run, messages),
    score: run.score === undefined ? '–' : `${run.score}/5`,
    findings: run.findings === undefined ? '–' : String(run.findings),
    when: relativeTime(run.startedAt, time, messages.time),
    source: m.sources[sourceOf(run)],
  }))
  const width = (header: string, values: readonly string[]) =>
    Math.max(textWidth(header), ...values.map(textWidth))
  const others = {
    verdict: width(
      m.columns.verdict,
      rows.map(({ verdict }) => verdict),
    ),
    score: width(
      m.columns.score,
      rows.map(({ score }) => score),
    ),
    findings: width(
      m.columns.findings,
      rows.map(({ findings }) => findings),
    ),
    when: width(
      m.columns.when,
      rows.map(({ when }) => when),
    ),
    source: width(
      m.columns.source,
      rows.map(({ source }) => source),
    ),
  }
  const fixed = 2 + Object.values(others).reduce((sum, value) => sum + value, 0) + GAP.length * 5
  const room = Math.max(size.columns - fixed - GAP.length, 0)
  const refWidth = Math.min(
    width(
      m.columns.pr,
      rows.map(({ ref }) => ref),
    ),
    Math.max(MIN_REF_WIDTH, Math.floor(room * REF_SHARE)),
  )
  const columns = { ...others, ref: refWidth }
  const titleWidth = Math.max(room - refWidth, 0)
  const line = (cells: {
    ref: string
    title: string
    verdict: string
    score: string
    findings: string
    when: string
    source: string
  }) =>
    [
      fit(cells.ref, columns.ref, 'start'),
      fit(cells.title, titleWidth),
      fit(cells.verdict, columns.verdict),
      fit(cells.score, columns.score),
      cells.findings.padStart(columns.findings),
      fit(cells.when, columns.when),
      fit(cells.source, columns.source),
    ].join(GAP)
  const summary = [
    m.count(total),
    ...(total > runs.length && text === '' ? [m.latest(runs.length)] : []),
  ].join(' · ')
  const head = showFilter ? [filter] : []
  return (
    <Box flexDirection="column" width={size.columns}>
      {head}
      {(total > 0 || text !== '') && <Text bold>{summary}</Text>}
      {runs.length === 0 ? (
        text === '' ? (
          <EmptyHistory />
        ) : (
          <Text color={colors.dim}>{m.noMatch(text)}</Text>
        )
      ) : (
        <>
          <Text color={colors.dim} wrap="truncate-end">
            {'  '}
            {line({
              ref: m.columns.pr,
              title: '',
              verdict: m.columns.verdict,
              score: m.columns.score,
              findings: m.columns.findings,
              when: m.columns.when,
              source: m.columns.source,
            })}
          </Text>
          <ScrollList
            items={rows}
            index={index}
            rows={Math.max(size.rows - head.length - 2, 1)}
            keyOf={({ run }) => runKey(run)}
            renderItem={(row) => (
              <>
                {fit(row.ref, columns.ref, 'start')}
                {GAP}
                {fit(row.title, titleWidth)}
                {GAP}
                <Text color={verdictColor(row.run, theme)}>
                  {fit(row.verdict, columns.verdict)}
                </Text>
                {GAP}
                {fit(row.score, columns.score)}
                {GAP}
                {row.findings.padStart(columns.findings)}
                {GAP}
                <Text color={colors.dim}>{fit(row.when, columns.when)}</Text>
                {GAP}
                {fit(row.source, columns.source)}
              </>
            )}
          />
        </>
      )}
    </Box>
  )
}

function EmptyHistory() {
  const messages = useMessages()
  const { colors } = useTheme()
  const m = messages.reviews
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{m.none}</Text>
      <Text color={colors.dim}>
        {m.noneHint}{' '}
        <Text bold color={colors.accent}>
          phada review owner/repo#N
        </Text>{' '}
        {m.or}{' '}
        <Text bold color={colors.accent}>
          phada watch
        </Text>
      </Text>
    </Box>
  )
}

function ReviewDetailView({ id }: { id: number }) {
  const { readReviewDetail } = useAppDeps()
  const messages = useMessages()
  const { colors } = useTheme()
  const state = usePolled(() => readReviewDetail(id), POLL_MS, String(id))
  return (
    <DataView state={state}>
      {(detail) =>
        detail === undefined ? (
          <Text color={colors.dim}>{messages.reviews.detail.gone}</Text>
        ) : (
          <ReviewDetailLines detail={detail} />
        )
      }
    </DataView>
  )
}

function ReviewDetailLines({ detail }: { detail: ReviewDetail }) {
  const messages = useMessages()
  const theme = useTheme()
  const { colors } = theme
  const { now } = useAppDeps()
  const size = useScreenSize()
  const m = messages.reviews
  const d = m.detail
  const { run } = detail
  const time = now()
  const title = detail.pullRequest.title === null ? '' : ` · ${oneLine(detail.pullRequest.title)}`
  const ai = [run.provider, run.model]
    .filter((part) => part !== undefined)
    .map((part) => oneLine(part))
  const reviewed = [
    `${absoluteTime(run.startedAt)} (${relativeTime(run.startedAt, time, messages.time)})`,
    ...(ai.length === 0 ? [] : [ai.join(' ')]),
    m.sources[sourceOf(run)],
    run.headSha.slice(0, 7),
  ].join(' · ')
  const error =
    run.error ?? (run.status === 'failed' || run.status === 'skipped' ? run.reason : undefined)
  const section = (heading: string, lines: ReactNode[]) =>
    lines.length === 0 ? [] : [<Text> </Text>, <Text bold>{heading}</Text>, ...lines]
  const lines: ReactNode[] = [
    <Text bold>
      {oneLine(`${run.repo}#${run.number}`)}
      {title}
    </Text>,
    <Text color={colors.info}>{oneLine(detail.pullRequest.url)}</Text>,
    <Text> </Text>,
    ...labeledLines(
      [
        [
          d.score,
          detail.score === null
            ? undefined
            : `${detail.score.value}/5${detail.score.reason === null ? '' : ` — ${oneLine(detail.score.reason)}`}`,
        ],
        [d.verdict, detail.verdict === null ? undefined : m.verdicts[detail.verdict]],
        [d.status, m.statuses[run.status]],
        [d.reviewed, reviewed],
        [d.ci, detail.ci === null ? undefined : ciLine(detail.ci, messages)],
        [d.published, publicationLine(detail.publication, messages)],
        [d.error, error === undefined ? undefined : oneLine(error)],
      ],
      size.columns,
      colors.soft,
    ),
    ...section(
      d.summary,
      detail.summary === null
        ? []
        : wrapText(detail.summary, size.columns - 2).map((line) => <Text>{`  ${line}`}</Text>),
    ),
    ...section(
      d.findings(detail.findings.length),
      findingLines(detail.findings, theme, size.columns),
    ),
    ...section(
      d.worthChecking(detail.worthChecking.length),
      findingLines(detail.worthChecking, theme, size.columns),
    ),
    ...section(
      d.feedback(detail.published.length),
      feedbackLines(detail.published, messages, theme, size.columns),
    ),
  ]
  return <ScrollText lines={lines} rows={size.rows} />
}

function findingLines(
  findings: readonly StoredFinding[],
  theme: Theme,
  columns: number,
): ReactNode[] {
  const places = findings.map((finding) => place(finding.file, finding.line ?? undefined))
  const width = placeWidth(places, columns)
  return findings.map((finding, index) => (
    <Text>
      {'  '}
      <Text bold color={severityColor(finding.severity, theme)}>
        {fit(finding.severity ?? '–', 2)}
      </Text>
      {GAP}
      {fit(places[index] ?? '', width, 'start')}
      {GAP}
      {oneLine(finding.title)}
    </Text>
  ))
}

function feedbackLines(
  published: readonly FeedbackFinding[],
  messages: UiMessages,
  theme: Theme,
  columns: number,
): ReactNode[] {
  const outcomes = Object.values(messages.reviews.outcomes)
  const outcomeWidth = Math.max(...outcomes.map(textWidth))
  const places = published.map((finding) => place(finding.file, finding.line))
  const width = placeWidth(places, columns)
  return published.map((finding, index) => {
    const marks = finding.marks
      .filter((mark) => mark === 'negative-reaction' || mark === 'human-reply')
      .map((mark) => messages.reviews.marks[mark])
    return (
      <Text>
        {'  '}
        <Text color={outcomeColor(finding.destination, theme)}>
          {fit(messages.reviews.outcomes[finding.destination], outcomeWidth)}
        </Text>
        {GAP}
        {fit(places[index] ?? '', width, 'start')}
        {GAP}
        {[oneLine(finding.title), ...marks].join(' · ')}
      </Text>
    )
  })
}

function ciLine(ci: NonNullable<ReviewDetail['ci']>, messages: UiMessages): string {
  const d = messages.reviews.detail
  const names = (values: readonly string[]) => values.map(oneLine).join(', ')
  return [
    messages.reviews.ciStates[ci.state] ?? oneLine(ci.state),
    ...(ci.failing.length === 0 ? [] : [d.failing(names(ci.failing))]),
    ...(ci.pending.length === 0 ? [] : [d.pending(names(ci.pending))]),
  ].join(' · ')
}

function publicationLine(
  publication: ReviewDetail['publication'],
  messages: UiMessages,
): string | undefined {
  if (publication === null) return undefined
  const m = messages.reviews
  const status =
    publication.status === 'published' ? [] : [statusLabel(publication.status, messages)]
  return [
    ...status,
    ...(publication.comments === null ? [] : [m.detail.comments(publication.comments)]),
    ...(publication.url === null ? [] : [oneLine(publication.url)]),
  ].join(' · ')
}

function statusLabel(status: string, messages: UiMessages): string {
  const statuses: Readonly<Record<string, string>> = messages.reviews.statuses
  return statuses[status] ?? oneLine(status)
}

function verdictLabel(run: ListedRun, messages: UiMessages): string {
  return run.verdict === undefined
    ? messages.reviews.statuses[run.status]
    : messages.reviews.verdicts[run.verdict]
}

function sourceOf(run: ListedRun): ReviewSource {
  return run.requestSource ?? run.source
}

function placeWidth(places: readonly string[], columns: number): number {
  return Math.min(Math.max(0, ...places.map(textWidth)), Math.floor(columns * PLACE_SHARE))
}

function place(file: string, line: number | undefined): string {
  return oneLine(line === undefined ? file : `${file}:${line}`)
}

function verdictColor(run: ListedRun, { colors }: Theme): string | undefined {
  const verdict = run.verdict ?? (run.status === 'failed' ? 'failed' : undefined)
  if (verdict === 'clean') return colors.ok
  if (verdict === 'comments') return colors.warn
  if (verdict === 'blocking' || verdict === 'failed') return colors.error
  return colors.dim
}

function severityColor(severity: string | null, { colors }: Theme): string | undefined {
  if (severity === 'P0') return colors.error
  if (severity === 'P1') return colors.warn
  return colors.info
}

function outcomeColor(
  outcome: FeedbackFinding['destination'],
  { colors }: Theme,
): string | undefined {
  if (outcome === 'fixed') return colors.ok
  if (outcome === 'dismissed') return colors.warn
  if (outcome === 'ignored') return colors.dim
  return colors.info
}
