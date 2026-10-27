import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { useState } from 'react'
import type { QueueJob, QueueView } from '../../app/read-queue.js'
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
import type { QueueRowKind, UiMessages } from '../i18n/messages.js'
import { labeledLines } from '../labeled-lines.js'
import { absoluteTime, relativeTime } from '../relative-time.js'
import { ScrollList, ScrollText, useSelection } from '../scroll-list.js'
import { textWidth } from '../tab-layout.js'
import type { Theme } from '../theme.js'
import { fit, namesText, oneLine, shortenHome } from '../text-fit.js'

interface QueueRow {
  kind: QueueRowKind
  entry: QueueJob
}

const MAX_REF_WIDTH = 24
const NAMES_SHOWN = 3

export function queueRows(view: QueueView): QueueRow[] {
  const rows = (kind: QueueRowKind, entries: readonly QueueJob[]) =>
    entries.map((entry) => ({ kind, entry }))
  return [
    ...rows('running', view.running),
    ...rows(
      'waiting',
      view.queue.filter(({ job }) => job.status === 'waiting'),
    ),
    ...rows(
      'queued',
      view.queue.filter(({ job }) => job.status !== 'waiting'),
    ),
    ...rows('skipped', view.skippedForCi),
    ...rows('failed', view.failed),
  ]
}

const rowKey = ({ kind, entry }: QueueRow) => `${kind}:${entry.job.id}`

export function QueueScreen() {
  const { readQueue } = useAppDeps()
  const messages = useMessages()
  const state = usePolled(readQueue)
  const [open, setOpen] = useState<string | undefined>()
  const rows = state.status === 'ready' ? queueRows(state.value) : []
  const selection = useSelection(rows, rowKey, {
    active: open === undefined,
    onOpen: (row) => setOpen(rowKey(row)),
  })
  useBack(open === undefined ? undefined : () => setOpen(undefined))
  useScreenKeys(
    open === undefined
      ? rows.length === 0
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
  return (
    <DataView state={state}>
      {(view) =>
        open === undefined ? (
          <QueueList view={view} rows={rows} index={selection.index} />
        ) : (
          <JobDetail row={rows.find((row) => rowKey(row) === open)} />
        )
      }
    </DataView>
  )
}

function QueueList({
  view,
  rows,
  index,
}: {
  view: QueueView
  rows: readonly QueueRow[]
  index: number
}) {
  const messages = useMessages()
  const theme = useTheme()
  const { colors } = theme
  const { now, home } = useAppDeps()
  const size = useScreenSize()
  const time = now()
  const header = headerLines(view, time, home, messages, theme)
  const kindWidth = Math.max(...Object.values(messages.queue.kinds).map(textWidth))
  const refWidth = Math.min(
    Math.max(0, ...rows.map(({ entry }) => textWidth(jobRef(entry)))),
    MAX_REF_WIDTH,
  )
  return (
    <Box flexDirection="column" width={size.columns}>
      {header.map((line, position) => (
        <Text key={position} wrap="truncate-end">
          {line}
        </Text>
      ))}
      <Text> </Text>
      {rows.length === 0 ? (
        <Text color={colors.dim}>
          {view.recorded ? messages.queue.empty : messages.queue.never}
        </Text>
      ) : (
        <ScrollList
          items={rows}
          index={index}
          rows={Math.max(size.rows - header.length - 1, 1)}
          keyOf={rowKey}
          renderItem={(row) => (
            <>
              <Text color={kindColor(row.kind, theme)}>
                {fit(messages.queue.kinds[row.kind], kindWidth)}
              </Text>
              {'  '}
              {fit(jobRef(row.entry), refWidth, 'start')}
              {'  '}
              <Text color={colors.dim}>{shortSha(row.entry.job.headSha)}</Text>
              {'  '}
              {rowDetail(row, time, messages)}
            </>
          )}
        />
      )}
    </Box>
  )
}

function headerLines(
  view: QueueView,
  now: Date,
  home: string,
  messages: UiMessages,
  theme: Theme,
): ReactNode[] {
  const { colors } = theme
  const m = messages.queue
  const when = (at: string) => relativeTime(at, now, messages.time)
  const cycle = view.lastCycleAt === null ? [] : [m.lastCycle(when(view.lastCycleAt))]
  const command = (
    <Text bold color={colors.accent}>
      phada watch
    </Text>
  )
  if (view.holder === null && !view.watchConfigured) {
    return [
      <Text>
        <Text color={colors.dim}>○ </Text>
        <Text bold>{m.notConfigured}</Text>
      </Text>,
      <Text>
        {m.setUp(oneLine(shortenHome(view.configFile, home)))} {command}
      </Text>,
    ]
  }
  const watch =
    view.holder === null ? (
      <Text>
        <Text color={colors.dim}>○ </Text>
        <Text bold>{m.stopped}</Text>
        {[...cycle, m.startWith].map((part) => ` · ${part}`).join('')} {command}
      </Text>
    ) : (
      <Text>
        <Text color={colors.ok}>● </Text>
        <Text bold>{m.running(view.holder.pid)}</Text>
        {[
          ...cycle,
          ...(view.nextCycle === null
            ? []
            : [m.next(relativeTime(view.nextCycle.at, now, messages.time, { estimated: true }))]),
        ]
          .map((part) => ` · ${part}`)
          .join('')}
      </Text>
    )
  const lines: ReactNode[] = [watch]
  if (view.pause !== null) {
    const reason =
      view.pause.reason === 'rate-limit' ? m.pauseReasons.rateLimit : m.pauseReasons.usageLimit
    lines.push(
      <Text color={colors.warn} bold={colors.warn === undefined}>
        ‖ {m.paused(absoluteTime(view.pause.until), when(view.pause.until), reason)}
      </Text>,
    )
  }
  if (view.hourly !== null) {
    lines.push(<Text color={colors.dim}>{m.hourly(view.hourly.count, view.hourly.max)}</Text>)
  }
  return lines
}

function rowDetail({ kind, entry }: QueueRow, now: Date, messages: UiMessages): string {
  const m = messages.queue
  const { job } = entry
  const when = (at: string) => relativeTime(at, now, messages.time)
  const parts: string[] = []
  if (kind === 'running' && job.startedAt !== undefined) parts.push(m.started(when(job.startedAt)))
  if (kind === 'queued') {
    parts.push(Date.parse(job.notBefore) > now.getTime() ? m.starts(when(job.notBefore)) : m.ready)
    if (job.attempts > 0) parts.push(m.attempt(job.attempts + 1))
  }
  if (kind === 'waiting') {
    parts.push(m.ciUntil(when(job.ciDeadline ?? job.notBefore)))
    const pending = job.ciPending ?? []
    parts.push(
      pending.length === 0
        ? m.noChecks
        : m.pending(pending.length, namesText(pending, NAMES_SHOWN)),
    )
  }
  if (kind === 'skipped') {
    parts.push(m.failing(namesText(job.ciFailing ?? [], NAMES_SHOWN)))
    if (job.ciCheckedAt !== undefined) parts.push(m.checked(when(job.ciCheckedAt)))
  }
  if (kind === 'failed') {
    if (job.finishedAt !== undefined) parts.push(when(job.finishedAt))
    const error = errorText(job)
    if (error !== undefined) parts.push(error)
  }
  const sources = [
    ...new Set(entry.requests.map(({ source }) => source).filter((source) => source !== 'watch')),
  ]
  if (sources.length > 0) {
    parts.push(m.askedFrom(sources.map((source) => messages.requests.sources[source]).join(', ')))
  }
  return parts.join(' · ')
}

function JobDetail({ row }: { row: QueueRow | undefined }) {
  const messages = useMessages()
  const { colors } = useTheme()
  const { now } = useAppDeps()
  const size = useScreenSize()
  if (row === undefined) return <Text color={colors.dim}>{messages.queue.detail.gone}</Text>
  const m = messages.queue
  const d = m.detail
  const time = now()
  const { job, requests } = row.entry
  const at = (iso: string | undefined, estimated = false) =>
    iso === undefined
      ? undefined
      : `${absoluteTime(iso)} (${relativeTime(iso, time, messages.time, { estimated })})`
  const list = (values: readonly string[] | undefined) =>
    values === undefined || values.length === 0 ? undefined : values.map(oneLine).join(', ')
  const sourceWidth = Math.max(
    0,
    ...requests.map(({ source }) => textWidth(messages.requests.sources[source])),
  )
  const lines: ReactNode[] = [
    <Text bold>
      {jobRef(row.entry)} · {shortSha(job.headSha)} · {m.statuses[job.status]}
    </Text>,
    <Text> </Text>,
    ...labeledLines(
      [
        [d.created, at(job.createdAt)],
        [
          d.notBefore,
          job.status === 'queued' || job.status === 'waiting' ? at(job.notBefore) : undefined,
        ],
        [d.started, at(job.startedAt)],
        [d.finished, at(job.finishedAt)],
        [d.ciDeadline, at(job.ciDeadline)],
        [d.pending, list(job.ciPending)],
        [d.failing, list(job.ciFailing)],
        [d.checked, at(job.ciCheckedAt)],
        [d.attempts, job.attempts > 0 ? String(job.attempts) : undefined],
        [d.error, errorText(job)],
        [d.publish, job.publish === undefined ? undefined : messages.requests.publish[job.publish]],
      ],
      size.columns,
      colors.soft,
    ),
    <Text> </Text>,
    <Text bold>{d.requests(requests.length)}</Text>,
    ...requests.flatMap((request) => {
      const who = requestOrigin(request, messages)
      const url = typeof request.data?.url === 'string' ? oneLine(request.data.url) : undefined
      return [
        <Text>
          {'  '}
          <Text color={colors.soft}>
            {fit(messages.requests.sources[request.source], sourceWidth)}
          </Text>
          {'  '}
          {[
            ...(who === undefined ? [] : [who]),
            messages.requests.publish[request.publish],
            relativeTime(request.createdAt, time, messages.time),
          ].join(' · ')}
        </Text>,
        ...(url === undefined
          ? []
          : [
              <Text color={colors.dim}>
                {' '.repeat(sourceWidth + 4)}
                {url}
              </Text>,
            ]),
      ]
    }),
  ]
  return <ScrollText lines={lines} rows={size.rows} />
}

function requestOrigin(
  request: QueueJob['requests'][number],
  messages: UiMessages,
): string | undefined {
  const { author, channel } = request.data ?? {}
  if (typeof author === 'string') return messages.requests.author(oneLine(author))
  if (typeof channel === 'string') return messages.requests.channel(oneLine(channel))
  return undefined
}

function errorText(job: QueueJob['job']): string | undefined {
  const message = job.error ?? job.reason
  if (message === undefined) return undefined
  const text = oneLine(message)
  return job.errorKind === undefined ? text : `${job.errorKind}: ${text}`
}

function jobRef(entry: QueueJob): string {
  return oneLine(`${entry.job.repo}#${entry.job.number}`)
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function kindColor(kind: QueueRowKind, { colors }: Theme): string | undefined {
  if (kind === 'running') return colors.info
  if (kind === 'failed') return colors.error
  if (kind === 'queued') return colors.soft
  return colors.warn
}
