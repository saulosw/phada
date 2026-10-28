import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { useState } from 'react'
import type { ListedRun } from '../../app/read-history.js'
import {
  useAppDeps,
  useBack,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useScreenSize,
  useStartReview,
  useTheme,
} from '../app-context.js'
import { usePolled, POLL_MS } from '../data-hooks.js'
import { DataView } from '../data-view.js'
import { relativeTime } from '../relative-time.js'
import { reviewDetailLines } from '../review-detail.js'
import { runKey, sourceOf, verdictColor, verdictLabel } from '../run-text.js'
import { ScrollList, ScrollText, useSelection } from '../scroll-list.js'
import { textWidth } from '../tab-layout.js'
import { TextFieldLine, useTextField } from '../text-field.js'
import { fit, oneLine } from '../text-fit.js'

export const REVIEWS_SHOWN = 200
const MIN_REF_WIDTH = 12
const REF_SHARE = 0.45
const GAP = '  '

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
  const startReview = useStartReview()
  useScreenInput((input) => {
    if (listing && input === 'f') filter.focus()
    if (listing && input === 'n') startReview()
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
            { keys: 'n', label: messages.reviews.newReview },
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
  const { readReviewDetail, now } = useAppDeps()
  const messages = useMessages()
  const theme = useTheme()
  const { colors } = theme
  const size = useScreenSize()
  const draw = { messages, theme, width: size.columns }
  const state = usePolled(() => readReviewDetail(id), POLL_MS, String(id))
  return (
    <DataView state={state}>
      {(detail) =>
        detail === undefined ? (
          <Text color={colors.dim}>{messages.reviews.detail.gone}</Text>
        ) : (
          <ScrollText lines={reviewDetailLines(detail, draw, now())} rows={size.rows} />
        )
      }
    </DataView>
  )
}
