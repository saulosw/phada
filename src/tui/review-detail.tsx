import { Text } from 'ink'
import type { ReactNode } from 'react'
import type { FeedbackFinding, ReviewDetail, StoredFinding } from '../app/read-history.js'
import type { DrawContext } from './frame-lines.js'
import type { UiMessages } from './i18n/messages.js'
import { labeledLines } from './labeled-lines.js'
import { absoluteTime, relativeTime } from './relative-time.js'
import { sourceOf } from './run-text.js'
import { textWidth } from './tab-layout.js'
import type { Theme } from './theme.js'
import { fit, oneLine, wrapText } from './text-fit.js'
import { pullRef, shortSha } from './refs.js'

const PLACE_SHARE = 0.4
const GAP = '  '
const BODY_INDENT = '      '

export function reviewDetailLines(
  detail: ReviewDetail,
  { messages, theme, width }: DrawContext,
  time: Date,
): ReactNode[] {
  const { colors } = theme
  const m = messages.reviews
  const d = m.detail
  const { run } = detail
  const title = detail.pullRequest.title === null ? '' : ` · ${oneLine(detail.pullRequest.title)}`
  const ai = [run.provider, run.model]
    .filter((part) => part !== undefined)
    .map((part) => oneLine(part))
  const reviewed = [
    `${absoluteTime(run.startedAt)} (${relativeTime(run.startedAt, time, messages.time)})`,
    ...(ai.length === 0 ? [] : [ai.join(' ')]),
    m.sources[sourceOf(run)],
    shortSha(run.headSha),
  ].join(' · ')
  const error =
    run.error ?? (run.status === 'failed' || run.status === 'skipped' ? run.reason : undefined)
  const section = (heading: string, lines: ReactNode[]) =>
    lines.length === 0 ? [] : [<Text> </Text>, <Text bold>{heading}</Text>, ...lines]
  const lines: ReactNode[] = [
    <Text bold>
      {pullRef(run.repo, run.number)}
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
      width,
      colors.soft,
    ),
    ...section(
      d.summary,
      detail.summary === null
        ? []
        : wrapText(detail.summary, width - 2).map((line) => <Text>{`  ${line}`}</Text>),
    ),
    ...section(d.findings(detail.findings.length), findingLines(detail.findings, theme, width)),
    ...section(
      d.worthChecking(detail.worthChecking.length),
      findingLines(detail.worthChecking, theme, width),
    ),
    ...section(
      d.feedback(detail.published.length),
      feedbackLines(detail.published, messages, theme, width),
    ),
  ]
  return lines
}

function findingLines(
  findings: readonly StoredFinding[],
  theme: Theme,
  columns: number,
): ReactNode[] {
  const places = findings.map((finding) => place(finding.file, finding.line ?? undefined))
  const width = placeWidth(places, columns)
  return findings.flatMap((finding, index) => [
    <Text>
      {'  '}
      <Text bold color={severityColor(finding.severity, theme)}>
        {fit(finding.severity ?? '–', 2)}
      </Text>
      {GAP}
      {fit(places[index] ?? '', width, 'start')}
      {GAP}
      {oneLine(finding.title)}
    </Text>,
    ...(finding.why === null
      ? []
      : wrapText(finding.why, columns - BODY_INDENT.length).map((line) => (
          <Text color={theme.colors.dim}>{`${BODY_INDENT}${line}`}</Text>
        ))),
  ])
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
  const d = m.detail
  const dryRun = publication.status === 'dry-run'
  const status =
    publication.status === 'published' || dryRun ? [] : [statusLabel(publication.status, messages)]
  const reason =
    publication.reason === null
      ? undefined
      : (d.skipReasons[publication.reason] ?? oneLine(publication.reason))
  return [
    ...status,
    ...(dryRun ? [d.nothingPosted] : []),
    ...(publication.comments === null ? [] : [d.comments(publication.comments)]),
    ...(publication.wouldResolve === null || publication.wouldResolve === 0
      ? []
      : [d.wouldResolve(publication.wouldResolve)]),
    ...(reason === undefined ? [] : [dryRun ? d.wouldSkip(reason) : reason]),
    ...(publication.url === null ? [] : [oneLine(publication.url)]),
  ].join(' · ')
}

function statusLabel(status: string, messages: UiMessages): string {
  const statuses: Readonly<Record<string, string>> = messages.reviews.statuses
  return statuses[status] ?? oneLine(status)
}

function placeWidth(places: readonly string[], columns: number): number {
  return Math.min(Math.max(0, ...places.map(textWidth)), Math.floor(columns * PLACE_SHARE))
}

function place(file: string, line: number | undefined): string {
  return oneLine(line === undefined ? file : `${file}:${line}`)
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
