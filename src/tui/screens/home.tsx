import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { errorMessage } from '../../app/error-message.js'
import { recentFailures } from '../../app/home-recommendation.js'
import type { Recommendation } from '../../app/home-recommendation.js'
import { HOME_REVIEWS, homeSnapshot, readHomeLocal } from '../../app/read-home.js'
import type { Fact, HomeSnapshot } from '../../app/read-home.js'
import type { ListedRun } from '../../app/read-history.js'
import { nextStep } from '../../app/read-provider.js'
import type { ReportedProvider } from '../../app/read-provider.js'
import { useAppDeps, useMessages, useScreenKeys, useScreenSize, useTheme } from '../app-context.js'
import { useLoaded, usePolled } from '../data-hooks.js'
import type { DataState } from '../data-hooks.js'
import { DataView, failedText } from '../data-view.js'
import type { UiMessages } from '../i18n/messages.js'
import { Mascot } from '../mascot.js'
import { absoluteTime, relativeTime } from '../relative-time.js'
import { textWidth } from '../tab-layout.js'
import type { Theme } from '../theme.js'
import { fit, oneLine } from '../text-fit.js'
import { PROVIDER_NAMES } from './provider.js'
import { verdictColor, verdictLabel } from './reviews.js'

const BOX_CHROME = 22
const BOX_ROWS = 6
const STATUS_ROWS = 5
const MAX_REF_WIDTH = 24
const MAX_TITLE_WIDTH = 60
const GAP = '  '

type Mark = 'ok' | 'attention' | 'off' | 'error' | 'pending'

interface StatusLine {
  label: string
  mark: Mark
  text: string
}

interface Draw {
  messages: UiMessages
  theme: Theme
  home: string
  now: Date
  width: number
}

export function shortenHome(path: string, home: string): string {
  if (home === '' || home === '/') return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

export function HomeScreen() {
  const deps = useAppDeps()
  const messages = useMessages()
  const theme = useTheme()
  const size = useScreenSize()
  const local = usePolled(() => readHomeLocal(deps))
  const github = useLoaded('github', deps.readGitHub)
  const providers = useLoaded('providers', deps.readProviders)
  useScreenKeys([{ keys: 'r', label: messages.keys.refresh }])
  const now = deps.now()
  const draw: Draw = { messages, theme, home: deps.home, now, width: size.columns }
  return (
    <Box flexDirection="column" width={size.columns}>
      <Welcome width={size.columns} />
      <Text> </Text>
      <DataView state={local}>
        {(value) => (
          <Snapshot
            snapshot={homeSnapshot(
              value,
              { github: factOf(github.state), providers: factOf(providers.state) },
              now,
            )}
            rows={size.rows - BOX_ROWS - 1}
            draw={draw}
          />
        )}
      </DataView>
    </Box>
  )
}

function Welcome({ width }: { width: number }) {
  const { version, cwd, home } = useAppDeps()
  const messages = useMessages()
  const { colors } = useTheme()
  const room = Math.max(width - BOX_CHROME, 1)
  return (
    <Box borderStyle="round" borderColor={colors.accent} paddingX={2} alignSelf="flex-start">
      <Box marginRight={3}>
        <Mascot />
      </Box>
      <Box flexDirection="column" justifyContent="center">
        <Text>
          <Text bold>Phada</Text>
          <Text color={colors.dim}> {cut(`v${version}`, room - 6, 'end')}</Text>
        </Text>
        <Text color={colors.soft}>{cut(messages.home.tagline, room, 'end')}</Text>
        <Text color={colors.dim}>{cut(oneLine(shortenHome(cwd, home)), room, 'start')}</Text>
      </Box>
    </Box>
  )
}

function Snapshot({ snapshot, rows, draw }: { snapshot: HomeSnapshot; rows: number; draw: Draw }) {
  const { messages, theme } = draw
  const statuses = statusLines(snapshot, draw)
  const labelWidth = Math.max(...statuses.map(({ label }) => textWidth(label)))
  const advice = recommendationLines(snapshot.recommendation, draw)
  const reviewRows = Math.max(
    Math.min(HOME_REVIEWS, rows - STATUS_ROWS - 1 - advice.length - 1 - 1),
    0,
  )
  return (
    <>
      {statuses.map(({ label, mark, text }) => (
        <Text key={label} wrap="truncate-end">
          <Text bold>{fit(label, labelWidth)}</Text>
          {GAP}
          <MarkIcon mark={mark} theme={theme} /> {text}
        </Text>
      ))}
      <Text> </Text>
      {advice.map((line, index) => (
        <Text key={index} wrap="truncate-end">
          {line}
        </Text>
      ))}
      {reviewRows > 0 && (
        <>
          <Text> </Text>
          <Text bold>{messages.home.reviews.title}</Text>
          <ReviewRows reviews={snapshot.reviews} rows={reviewRows} draw={draw} />
        </>
      )}
    </>
  )
}

function statusLines(snapshot: HomeSnapshot, draw: Draw): StatusLine[] {
  const { labels } = draw.messages.home
  return [
    { label: labels.github, ...githubStatus(snapshot, draw) },
    { label: labels.ai, ...aiStatus(snapshot, draw) },
    { label: labels.watch, ...watchStatus(snapshot, draw) },
    { label: labels.queue, ...queueStatus(snapshot, draw) },
    { label: labels.graph, ...graphStatus(snapshot, draw) },
  ]
}

type Status = Omit<StatusLine, 'label'>

function githubStatus({ github }: HomeSnapshot, { messages }: Draw): Status {
  const m = messages.home
  if (github.status === 'loading') return { mark: 'pending', text: m.checking }
  if (github.status === 'failed') return failedStatus(github.error, messages)
  const access = github.value
  if (access.source === null) return { mark: 'attention', text: m.github.noToken }
  const source = m.github.sources[access.source]
  const { account } = access
  if (account.state === 'found')
    return { mark: 'ok', text: `${source} · ${oneLine(account.login)}` }
  if (account.state === 'refused') return { mark: 'error', text: `${source} · ${m.github.refused}` }
  return { mark: 'error', text: `${source} · ${oneLine(account.error)}` }
}

function aiStatus({ setup, providers }: HomeSnapshot, { messages }: Draw): Status {
  if (setup.status !== 'ready') {
    return setup.status === 'failed'
      ? failedStatus(setup.error, messages)
      : { mark: 'pending', text: messages.loading }
  }
  const { provider, model } = setup.value.choice
  const modelText =
    model !== null
      ? oneLine(model)
      : provider === 'ollama'
        ? messages.provider.ollamaModel
        : messages.home.defaultModel
  const chosen = `${PROVIDER_NAMES[provider]} · ${modelText}`
  if (providers.status === 'loading') {
    return { mark: 'pending', text: `${chosen} · ${messages.home.checking}` }
  }
  if (providers.status === 'failed') {
    return { mark: 'error', text: `${chosen} · ${failedText(messages, providers.error)}` }
  }
  const status = providers.value.providers.find((checked) => checked.provider === provider)
  if (status === undefined) return { mark: 'pending', text: chosen }
  const step = nextStep({ ...status, chosen: true }, model)
  return {
    mark: step !== undefined ? 'attention' : isReady(status) ? 'ok' : 'off',
    text: [chosen, ...providerState(status, messages)].join(' · '),
  }
}

function watchStatus({ queue, automation }: HomeSnapshot, { messages, now }: Draw): Status {
  const m = messages.home.watch
  if (queue.status !== 'ready') return pendingOrFailed(queue, messages)
  const view = queue.value
  const lastCycle =
    view.lastCycleAt === null
      ? []
      : [m.lastCycle(relativeTime(view.lastCycleAt, now, messages.time))]
  if (view.holder !== null) {
    const next =
      view.nextCycle === null
        ? []
        : [m.next(relativeTime(view.nextCycle.at, now, messages.time, { estimated: true }))]
    return { mark: 'ok', text: [m.running(view.holder.pid), ...lastCycle, ...next].join(' · ') }
  }
  const configured = automation.status === 'ready' && automation.value.watch !== null
  if (!configured) return { mark: 'off', text: m.notConfigured }
  return { mark: 'attention', text: [m.stopped, ...lastCycle].join(' · ') }
}

function queueStatus({ queue }: HomeSnapshot, { messages, now }: Draw): Status {
  const m = messages.home.queue
  if (queue.status !== 'ready') return pendingOrFailed(queue, messages)
  const view = queue.value
  const waiting = view.queue.filter(({ job }) => job.status === 'waiting').length
  const count = (value: number, text: (value: number) => string) => (value > 0 ? [text(value)] : [])
  const failed = recentFailures(view, now).length
  const parts = [
    ...count(view.running.length, m.running),
    ...count(view.queue.length - waiting, m.queued),
    ...count(waiting, m.waiting),
    ...count(failed, m.failed),
    ...count(view.skippedForCi.length, m.skipped),
    ...(view.pause === null
      ? []
      : [
          m.paused(
            absoluteTime(view.pause.until),
            relativeTime(view.pause.until, now, messages.time),
          ),
        ]),
  ]
  if (parts.length === 0) return { mark: 'off', text: m.empty }
  const trouble = failed > 0 || view.skippedForCi.length > 0 || view.pause !== null
  return { mark: trouble ? 'attention' : 'ok', text: parts.join(' · ') }
}

function graphStatus({ repositories }: HomeSnapshot, { messages }: Draw): Status {
  const m = messages.home.graph
  if (repositories.status !== 'ready') return pendingOrFailed(repositories, messages)
  const watched = repositories.value.repositories.filter(({ origins }) =>
    origins.includes('watched'),
  )
  if (watched.length === 0) return { mark: 'off', text: m.none }
  const missing = watched.filter(({ index }) => index.file === null).length
  return {
    mark: missing === 0 ? 'ok' : 'attention',
    text: [m.indexed(watched.length - missing), ...(missing > 0 ? [m.missing(missing)] : [])].join(
      ' · ',
    ),
  }
}

function recommendationLines(recommendation: Recommendation, draw: Draw): ReactNode[] {
  const { messages, theme, home, now } = draw
  const { colors } = theme
  const m = messages.home.recommendations
  if (recommendation.kind === 'checking') {
    return [
      <Text color={colors.dim}>… {m.checking(recommendation.github, recommendation.ai)}</Text>,
    ]
  }
  const headline = (text: string) => (
    <Text bold>
      <Text color={colors.accent}>→</Text> {text}
    </Text>
  )
  if (recommendation.kind === 'fix-config') {
    return [
      headline(m.fixConfig(oneLine(shortenHome(recommendation.file, home)))),
      <Text color={colors.error}>
        {GAP}
        {oneLine(recommendation.error)}
      </Text>,
    ]
  }
  return [
    headline(recommendationText(recommendation, messages, now)),
    <Text>
      {GAP}
      <Text bold color={colors.accent}>
        {oneLine(recommendation.command)}
      </Text>
    </Text>,
  ]
}

function recommendationText(
  recommendation: Exclude<Recommendation, { kind: 'checking' | 'fix-config' }>,
  messages: UiMessages,
  now: Date,
): string {
  const m = messages.home.recommendations
  switch (recommendation.kind) {
    case 'github-token':
      return m.githubToken
    case 'github-refused':
      return m.githubRefused(messages.home.github.sources[recommendation.source])
    case 'init':
      return m.init
    case 'ai':
      return m.ai[recommendation.step.kind](PROVIDER_NAMES[recommendation.provider])
    case 'paused': {
      const reasons = messages.queue.pauseReasons
      return m.paused(
        absoluteTime(recommendation.until),
        relativeTime(recommendation.until, now, messages.time),
        recommendation.reason === 'rate-limit' ? reasons.rateLimit : reasons.usageLimit,
      )
    }
    case 'failed-jobs':
      return m.failedJobs(
        recommendation.count,
        oneLine(recommendation.ref),
        recommendation.error === null ? null : oneLine(recommendation.error),
      )
    case 'ci-skipped':
      return m.ciSkipped(
        recommendation.count,
        oneLine(recommendation.ref),
        recommendation.failing.map(oneLine).join(', '),
      )
    case 'index':
      return m.index(oneLine(recommendation.repo), recommendation.count)
    case 'slack-tokens':
      return m.slackTokens(recommendation.missing)
    case 'watch':
      return m.watch
    case 'review':
      return m.review
  }
}

function ReviewRows({
  reviews,
  rows,
  draw,
}: {
  reviews: HomeSnapshot['reviews']
  rows: number
  draw: Draw
}) {
  const { messages, theme, now, width } = draw
  const { colors } = theme
  if (reviews.status !== 'ready') {
    const status = pendingOrFailed(reviews, messages)
    return <Text color={colors.error}>{status.text}</Text>
  }
  const runs = reviews.value.runs.slice(0, rows)
  if (runs.length === 0) {
    return (
      <Text color={colors.dim}>
        {GAP}
        {messages.home.reviews.none}
      </Text>
    )
  }
  const cells = runs.map((run) => ({
    run,
    ref: oneLine(`${run.repo}#${run.number}`),
    title: oneLine(run.title ?? ''),
    verdict: verdictLabel(run, messages),
    score: run.score === undefined ? '–' : `${run.score}/5`,
    when: relativeTime(run.startedAt, now, messages.time),
  }))
  const widest = (values: readonly string[]) => Math.max(0, ...values.map(textWidth))
  const refWidth = Math.min(widest(cells.map(({ ref }) => ref)), MAX_REF_WIDTH)
  const verdictWidth = widest(cells.map(({ verdict }) => verdict))
  const scoreWidth = widest(cells.map(({ score }) => score))
  const whenWidth = widest(cells.map(({ when }) => when))
  const titleWidth = Math.min(
    Math.max(
      width - GAP.length - refWidth - verdictWidth - scoreWidth - whenWidth - GAP.length * 4,
      0,
    ),
    MAX_TITLE_WIDTH,
  )
  return (
    <>
      {cells.map((cell) => (
        <Text key={runKey(cell.run)} wrap="truncate-end">
          {GAP}
          {fit(cell.ref, refWidth, 'start')}
          {GAP}
          {fit(cell.title, titleWidth)}
          {GAP}
          <Text color={verdictColor(cell.run, theme)}>{fit(cell.verdict, verdictWidth)}</Text>
          {GAP}
          {fit(cell.score, scoreWidth)}
          {GAP}
          <Text color={colors.dim}>{cell.when}</Text>
        </Text>
      ))}
    </>
  )
}

function MarkIcon({ mark, theme }: { mark: Mark; theme: Theme }) {
  const { colors } = theme
  if (mark === 'ok') return <Text color={colors.ok}>●</Text>
  if (mark === 'attention') {
    return (
      <Text color={colors.warn} bold={colors.warn === undefined}>
        ○
      </Text>
    )
  }
  if (mark === 'error') {
    return (
      <Text color={colors.error} bold={colors.error === undefined}>
        ✗
      </Text>
    )
  }
  if (mark === 'pending') return <Text color={colors.dim}>…</Text>
  return <Text color={colors.dim}>○</Text>
}

function providerState(status: ReportedProvider, messages: UiMessages): string[] {
  const m = messages.provider
  if (status.provider === 'ollama') {
    const { server } = status
    if (server.state === 'running') {
      return [
        m.running(server.version === null ? null : oneLine(server.version)),
        ...(server.models.length === 0 ? [m.noModels] : []),
      ]
    }
    if (server.state === 'stopped') return [m.stopped]
    return [m.serverUnknown(m.problems[server.problem])]
  }
  const { install, login } = status
  if (install.state === 'missing') return [m.notInstalled]
  if (login.state === 'logged-in') {
    return [m.loggedIn(login.method === null ? null : oneLine(login.method))]
  }
  if (login.state === 'logged-out') return [m.loggedOut]
  if (install.state === 'unknown') return [m.installUnknown(m.problems[install.problem])]
  return [m.loginUnknown(m.problems[login.problem])]
}

function isReady(status: ReportedProvider): boolean {
  return status.provider === 'ollama'
    ? status.server.state === 'running' && status.server.models.length > 0
    : status.install.state === 'installed' && status.login.state === 'logged-in'
}

function failedStatus(error: string, messages: UiMessages): Status {
  return { mark: 'error', text: failedText(messages, error) }
}

function pendingOrFailed<T>(fact: Fact<T>, messages: UiMessages): Status {
  return fact.status === 'failed'
    ? failedStatus(fact.error, messages)
    : { mark: 'pending', text: messages.loading }
}

function factOf<T>(state: DataState<T>): Fact<T> {
  if (state.status === 'failed') return { status: 'failed', error: errorMessage(state.error) }
  return state
}

function runKey(run: ListedRun): string {
  return String(run.id ?? `${run.repo}#${run.number}@${run.startedAt}`)
}

function cut(text: string, width: number, side: 'end' | 'start'): string {
  return textWidth(text) <= width ? text : fit(text, width, side)
}
