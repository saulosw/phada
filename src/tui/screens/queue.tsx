import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { QueueJob, QueueView } from '../../app/read-queue.js'
import {
  useAppDeps,
  useBack,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useScreenSize,
  useTheme,
} from '../app-context.js'
import { useAppWatch } from '../app-watch.js'
import type { AppWatchSession, RunningJob, WatchNotice } from '../app-watch.js'
import { usePolled } from '../data-hooks.js'
import { DataView } from '../data-view.js'
import { failedNodes, textLines } from '../frame-lines.js'
import type { DrawContext } from '../frame-lines.js'
import type { QueueRowKind, UiMessages } from '../i18n/messages.js'
import { labeledLines } from '../labeled-lines.js'
import { absoluteTime, relativeTime } from '../relative-time.js'
import { ScrollList, ScrollText, useSelection } from '../scroll-list.js'
import { textWidth } from '../tab-layout.js'
import type { Theme } from '../theme.js'
import { fit, namesText, oneLine, shortenHome } from '../text-fit.js'
import { stepText } from '../review-steps.js'
import { watchLogText, watchLogTone } from '../watch-log.js'
import type { WatchLogEntry } from '../watch-log.js'

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

type QueueMode = { kind: 'list' } | { kind: 'job'; key: string } | { kind: 'log' }

export function QueueScreen() {
  const { readQueue, pid } = useAppDeps()
  const messages = useMessages()
  const watch = useAppWatch()
  const state = usePolled(readQueue)
  const [mode, setMode] = useState<QueueMode>({ kind: 'list' })
  const rows = state.status === 'ready' ? queueRows(state.value) : []
  const holder = state.status === 'ready' ? state.value.holder?.pid : undefined
  const heldElsewhere = holder !== undefined && holder !== pid
  const listing = mode.kind === 'list'
  const selection = useSelection(rows, rowKey, {
    active: listing && !watch.asking,
    onOpen: (row) => setMode({ kind: 'job', key: rowKey(row) }),
  })
  const keepRunning = useRef(watch.keepRunning)
  keepRunning.current = watch.keepRunning
  useEffect(() => () => keepRunning.current(), [])
  const w = messages.queue.watch
  useBack(watch.asking ? watch.keepRunning : listing ? undefined : () => setMode({ kind: 'list' }))
  useScreenInput((input, key) => {
    if (!listing) return
    if (watch.asking) {
      if (key.return) watch.confirmStop()
      return
    }
    if (input === 'w') {
      watch.toggle(holder)
    } else if (input === 'l' && watch.log.length > 0) setMode({ kind: 'log' })
  })
  const watchKeys =
    watch.phase === 'running'
      ? [{ keys: 'w', label: w.stop }]
      : watch.phase === 'idle' && !heldElsewhere
        ? [{ keys: 'w', label: w.start }]
        : []
  useScreenKeys(
    watch.asking
      ? [
          { keys: 'Enter', label: w.stopConfirm },
          { keys: 'Esc', label: w.keepRunning },
        ]
      : listing
        ? [
            ...(rows.length === 0
              ? []
              : [
                  { keys: '↑/↓', label: messages.keys.select },
                  { keys: 'Enter', label: messages.keys.open },
                ]),
            ...watchKeys,
            ...(watch.log.length === 0 ? [] : [{ keys: 'l', label: w.log }]),
          ]
        : [
            { keys: '↑/↓', label: messages.list.scroll },
            { keys: 'Esc', label: messages.keys.back },
          ],
  )
  return (
    <DataView state={state}>
      {(view) =>
        mode.kind === 'list' ? (
          <QueueList view={view} rows={rows} index={selection.index} />
        ) : mode.kind === 'log' ? (
          <WatchLog />
        ) : (
          <JobDetail row={rows.find((row) => rowKey(row) === mode.key)} />
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
  const { now, home, pid } = useAppDeps()
  const watch = useAppWatch()
  const size = useScreenSize()
  const time = now()
  const header = [
    ...(watch.asking
      ? [
          <Text bold color={colors.warn}>
            {messages.queue.watch.stopQuestion}
          </Text>,
        ]
      : []),
    ...headerLines(view, { time, home, pid, watch }, messages, theme),
    ...noticeLines(watch.notice, { messages, theme, width: size.columns }),
  ]
  const kindWidth = Math.max(...Object.values(messages.queue.kinds).map(textWidth))
  const refWidth = Math.min(
    Math.max(0, ...rows.map(({ entry }) => textWidth(jobRef(entry)))),
    MAX_REF_WIDTH,
  )
  const room = Math.max(size.rows - header.length - 1, 1)
  const listRows =
    watch.log.length === 0 ? room : Math.min(Math.max(rows.length, 1), Math.ceil(room / 2))
  const logRows = Math.min(watch.log.length, Math.max(room - listRows - 2, 0))
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
          rows={listRows}
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
              {rowDetail(row, time, messages, watch.running)}
            </>
          )}
        />
      )}
      {logRows > 0 && (
        <>
          <Text> </Text>
          <Text bold color={colors.soft}>
            {messages.queue.log.title}
          </Text>
          {watch.log.slice(-logRows).map((entry, position) => (
            <Text key={position} wrap="truncate-end">
              {logLine(entry, messages, theme)}
            </Text>
          ))}
        </>
      )}
    </Box>
  )
}

function WatchLog() {
  const messages = useMessages()
  const theme = useTheme()
  const watch = useAppWatch()
  const size = useScreenSize()
  const lines =
    watch.log.length === 0
      ? [<Text color={theme.colors.dim}>{messages.queue.log.empty}</Text>]
      : watch.log.flatMap((entry) =>
          textLines(watchLogText(entry, messages), size.columns, logColor(entry, theme)),
        )
  return <ScrollText lines={lines} rows={size.rows} from="end" />
}

function logLine(entry: WatchLogEntry, messages: UiMessages, theme: Theme): ReactNode {
  return <Text color={logColor(entry, theme)}>{watchLogText(entry, messages)}</Text>
}

function logColor(entry: WatchLogEntry, theme: Theme): string | undefined {
  const tone = watchLogTone(entry)
  return tone === 'ok'
    ? theme.colors.ok
    : tone === 'warn'
      ? theme.colors.warn
      : tone === 'error'
        ? theme.colors.error
        : undefined
}

interface WatchHeader {
  time: Date
  home: string
  pid: number
  watch: AppWatchSession
}

function headerLines(
  view: QueueView,
  { time: now, home, pid, watch: session }: WatchHeader,
  messages: UiMessages,
  theme: Theme,
): ReactNode[] {
  const { colors } = theme
  const m = messages.queue
  const when = (at: string) => relativeTime(at, now, messages.time)
  const cycle = view.lastCycleAt === null ? [] : [m.lastCycle(when(view.lastCycleAt))]
  const parts = (values: readonly string[]) => values.map((part) => ` · ${part}`).join('')
  const here = session.phase === 'running' || view.holder?.pid === pid
  if (session.phase === 'starting' || session.phase === 'stopping') {
    return [
      <Text>
        <Text color={colors.warn}>{session.phase === 'starting' ? '○ ' : '● '}</Text>
        <Text bold>{session.phase === 'starting' ? m.starting : m.stopping}</Text>
        {parts(cycle)}
      </Text>,
      ...stateLines(view, now, messages, theme),
    ]
  }
  if (view.holder === null && session.phase === 'idle' && !view.watchConfigured) {
    return [
      <Text>
        <Text color={colors.dim}>○ </Text>
        <Text bold>{m.notConfigured}</Text>
      </Text>,
      <Text>
        {m.setUp(oneLine(shortenHome(view.configFile, home)))}{' '}
        <Text bold color={colors.accent}>
          phada watch
        </Text>
      </Text>,
    ]
  }
  const watch =
    view.holder === null && !here ? (
      <Text>
        <Text color={colors.dim}>○ </Text>
        <Text bold>{m.stopped}</Text>
        {parts([...cycle, m.startHere])}
      </Text>
    ) : (
      <Text>
        <Text color={colors.ok}>● </Text>
        <Text bold>
          {here || view.holder === null ? m.runningHere : m.runningElsewhere(view.holder.pid)}
        </Text>
        {parts([
          ...cycle,
          ...(view.nextCycle === null
            ? []
            : [m.next(relativeTime(view.nextCycle.at, now, messages.time, { estimated: true }))]),
        ])}
      </Text>
    )
  return [watch, ...stateLines(view, now, messages, theme)]
}

function stateLines(view: QueueView, now: Date, messages: UiMessages, theme: Theme): ReactNode[] {
  const { colors } = theme
  const m = messages.queue
  const lines: ReactNode[] = []
  if (view.pause !== null) {
    const reason =
      view.pause.reason === 'rate-limit' ? m.pauseReasons.rateLimit : m.pauseReasons.usageLimit
    lines.push(
      <Text color={colors.warn} bold={colors.warn === undefined}>
        ‖{' '}
        {m.paused(
          absoluteTime(view.pause.until),
          relativeTime(view.pause.until, now, messages.time),
          reason,
        )}
      </Text>,
    )
  }
  if (view.hourly !== null) {
    lines.push(<Text color={colors.dim}>{m.hourly(view.hourly.count, view.hourly.max)}</Text>)
  }
  return lines
}

function noticeLines(notice: WatchNotice | undefined, draw: DrawContext): ReactNode[] {
  if (notice === undefined) return []
  const w = draw.messages.queue.watch
  return notice.kind === 'elsewhere'
    ? [<Text color={draw.theme.colors.warn}>{w.elsewhere(notice.pid)}</Text>]
    : failedNodes(draw, notice.error, w.startFailed)
}

function rowDetail(
  { kind, entry }: QueueRow,
  now: Date,
  messages: UiMessages,
  running: RunningJob | undefined,
): string {
  const m = messages.queue
  const { job } = entry
  const when = (at: string) => relativeTime(at, now, messages.time)
  const parts: string[] = []
  if (kind === 'running' && job.startedAt !== undefined) parts.push(m.started(when(job.startedAt)))
  const step = running?.job.id === job.id ? running.steps.steps.at(-1) : undefined
  if (kind === 'running' && step !== undefined) {
    parts.push(stepText(step, jobRef(entry), messages, now.getTime()))
  }
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
