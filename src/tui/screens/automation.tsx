import { Text } from 'ink'
import type { ReactNode } from 'react'
import type { AutomationView } from '../../app/read-automation.js'
import { useAppDeps, useMessages, useScreenKeys, useScreenSize, useTheme } from '../app-context.js'
import { usePolled } from '../data-hooks.js'
import { DataView } from '../data-view.js'
import type { UiMessages } from '../i18n/messages.js'
import { labeledLines } from '../labeled-lines.js'
import { ScrollText } from '../scroll-list.js'
import { settingLines } from '../setting-lines.js'
import { textWidth } from '../tab-layout.js'
import type { Theme } from '../theme.js'
import { fit, oneLine, wrapText } from '../text-fit.js'
import { durationText } from '../units.js'

const GAP = '  '
const SLACK_BOT_TOKEN = 'PHADA_SLACK_BOT_TOKEN'
const SLACK_APP_TOKEN = 'PHADA_SLACK_APP_TOKEN'

export function AutomationScreen() {
  const { readAutomation } = useAppDeps()
  const messages = useMessages()
  const state = usePolled(readAutomation)
  useScreenKeys([{ keys: '↑/↓', label: messages.list.scroll }])
  return <DataView state={state}>{(view) => <AutomationLines view={view} />}</DataView>
}

function AutomationLines({ view }: { view: AutomationView }) {
  const messages = useMessages()
  const theme = useTheme()
  const { colors } = theme
  const size = useScreenSize()
  const m = messages.automation
  const width = size.columns - 2
  const note = (text: string, color = colors.dim) =>
    wrapText(text, width).map((line) => <Text color={color}>{`  ${line}`}</Text>)
  const section = (heading: ReactNode, lines: ReactNode[]) => [
    <Text> </Text>,
    <Text bold>{heading}</Text>,
    ...lines,
  ]
  const command = (text: string) => (
    <Text bold color={colors.accent}>
      {text}
    </Text>
  )
  const file = oneLine(view.configFile)
  const head: ReactNode[] = [
    ...(view.configError === null
      ? []
      : wrapText(messages.settings.invalid(view.configError), size.columns).map((line) => (
          <Text color={colors.error}>{line}</Text>
        ))),
    ...(view.configured
      ? []
      : [
          <Text>{messages.settings.noConfig}</Text>,
          <Text color={colors.dim}>
            {messages.settings.initHint} {command('phada init --global')}
          </Text>,
        ]),
  ]
  const lines: ReactNode[] = [
    ...head,
    ...(head.length === 0 ? [<Text bold>{m.watch}</Text>] : section(m.watch, [])),
    ...(view.watch === null
      ? note(m.watchOff(file))
      : indented(
          labeledLines(
            [
              [m.interval, durationText(view.watch.intervalMs)],
              [m.settle, durationText(view.watch.settleMs)],
              [m.perHour, m.perHourValue(view.watch.maxReviewsPerHour)],
              [m.repos, `${view.watch.repos.length}: ${view.watch.repos.map(oneLine).join(', ')}`],
            ],
            width,
            colors.soft,
          ),
        )),
    ...section(m.ci, [...settingLines(view.ci, messages, theme, size.columns), ...note(m.ciNote)]),
    ...section(m.sources, sourceLines(view, messages, theme, width)),
    ...section(
      view.hooks === null
        ? m.hooks
        : `${m.hooks} · ${m.timeout(durationText(view.hooks.timeoutMs))}`,
      view.hooks === null ? note(m.noHooks(file)) : hookLines(view.hooks, messages, theme, width),
    ),
    ...section(
      m.when,
      view.when.global === null && view.when.repos.length === 0
        ? note(m.noWhen)
        : pairLines(
            [
              ...(view.when.global === null ? [] : [[m.whenAll, view.when.global] as const]),
              ...view.when.repos.map(({ repo, command: text }) => [repo, text] as const),
            ],
            theme,
            width,
          ),
    ),
  ]
  return <ScrollText lines={lines} rows={size.rows} />
}

function sourceLines(
  view: AutomationView,
  messages: UiMessages,
  theme: Theme,
  width: number,
): ReactNode[] {
  const m = messages.automation
  const { sources } = view
  const { slack } = sources
  const entries: { label: string; on: boolean; value: string }[] = [
    { label: m.prComments, on: sources.prComments, value: '' },
    { label: m.enqueue, on: sources.enqueue, value: '' },
    { label: m.mcp, on: sources.mcp, value: '' },
    {
      label: m.slack,
      on: slack !== null,
      value:
        slack === null
          ? messages.settings.off
          : `${m.slackChannels(slack.channels.length)}: ${slack.channels
              .map(
                (channel) =>
                  `${oneLine(channel.id)} (${m.slackPublish[channel.publish]}, ${m.slackReply[channel.reply]})`,
              )
              .join(', ')}`,
    },
  ]
  const labelWidth = Math.max(...entries.map(({ label }) => textWidth(label)))
  const valueWidth = Math.max(width - labelWidth - 2 - GAP.length, 1)
  const indent = ' '.repeat(2 + 2 + labelWidth + GAP.length)
  const continued = (lines: readonly string[], color: string | undefined) =>
    lines.map((line) => (
      <Text color={color}>
        {indent}
        {line}
      </Text>
    ))
  const lines = entries.flatMap((entry) => {
    const color = entry.on ? undefined : theme.colors.dim
    const value =
      entry.value === '' ? (entry.on ? messages.settings.on : m.needsWatch) : entry.value
    const [first = '', ...rest] = wrapText(value, valueWidth)
    return [
      <Text>
        {'  '}
        <Text color={entry.on ? theme.colors.ok : theme.colors.dim}>
          {entry.on ? '●' : '○'}
        </Text>{' '}
        {fit(entry.label, labelWidth)}
        {GAP}
        <Text color={color}>{first}</Text>
      </Text>,
      ...continued(rest, color),
    ]
  })
  if (slack === null) return lines
  const tokens = [
    m.token(SLACK_BOT_TOKEN, slack.tokens.bot),
    m.token(SLACK_APP_TOKEN, slack.tokens.app),
  ].join(' · ')
  const missing = !slack.tokens.bot || !slack.tokens.app
  return [
    ...lines,
    ...continued(wrapText(tokens, valueWidth), missing ? theme.colors.warn : theme.colors.dim),
  ]
}

function hookLines(
  hooks: NonNullable<AutomationView['hooks']>,
  messages: UiMessages,
  theme: Theme,
  width: number,
): ReactNode[] {
  return pairLines(
    hooks.events.map(({ event, command }) => [event, command ?? messages.settings.notSet] as const),
    theme,
    width,
  )
}

function pairLines(
  pairs: readonly (readonly [string, string])[],
  { colors }: Theme,
  width: number,
): ReactNode[] {
  const labelWidth = Math.max(0, ...pairs.map(([label]) => textWidth(oneLine(label))))
  const valueWidth = Math.max(width - labelWidth - GAP.length, 1)
  return pairs.map(([label, value]) => (
    <Text>
      {'  '}
      <Text color={colors.soft}>{fit(oneLine(label), labelWidth)}</Text>
      {GAP}
      {fit(oneLine(value), valueWidth)}
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
