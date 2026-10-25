import { Text } from 'ink'
import type { ReactNode } from 'react'
import { errorMessage } from '../../app/error-message.js'
import type { ProviderReport, ProviderSetup, ReportedProvider } from '../../app/read-provider.js'
import { useAppDeps, useMessages, useScreenKeys, useScreenSize, useTheme } from '../app-context.js'
import { useLoaded, usePolled } from '../data-hooks.js'
import type { DataState } from '../data-hooks.js'
import type { UiMessages } from '../i18n/messages.js'
import { ScrollText } from '../scroll-list.js'
import { textWidth } from '../tab-layout.js'
import type { Theme } from '../theme.js'
import { fit, oneLine, wrapText } from '../text-fit.js'
import { shortenHome } from './home.js'

export const PROVIDER_NAMES: Readonly<Record<ReportedProvider['provider'], string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  ollama: 'Ollama',
}

const MODELS_SHOWN = 5
const MAX_MCP_NAME = 24

interface Draw {
  messages: UiMessages
  theme: Theme
  home: string
  width: number
}

export function ProviderScreen() {
  const { readProviderSetup, readProviders, home } = useAppDeps()
  const messages = useMessages()
  const theme = useTheme()
  const size = useScreenSize()
  const setup = usePolled(readProviderSetup)
  const { state: checked } = useLoaded(readProviders)
  const draw: Draw = { messages, theme, home, width: size.columns }
  const lines = [
    ...choiceLines(setup, draw),
    <Text> </Text>,
    ...providerLines(checked, draw),
    ...(setup.status === 'ready' ? [<Text> </Text>, ...mcpLines(setup.value, draw)] : []),
  ]
  useScreenKeys([
    { keys: 'r', label: messages.keys.refresh },
    ...(lines.length > size.rows ? [{ keys: '↑/↓', label: messages.list.scroll }] : []),
  ])
  return <ScrollText lines={lines} rows={size.rows} />
}

function choiceLines(setup: DataState<ProviderSetup>, draw: Draw): ReactNode[] {
  const { messages, home, width } = draw
  const { colors } = draw.theme
  const m = messages.provider
  if (setup.status === 'loading') return [<Text color={colors.dim}>{messages.loading}</Text>]
  if (setup.status === 'failed') {
    return [<Text color={colors.error}>{messages.failed(errorMessage(setup.error))}</Text>]
  }
  const { provider, model, origin } = setup.value.choice
  const modelText =
    model !== null ? (
      m.model(oneLine(model))
    ) : provider === 'ollama' ? (
      <Text color={colors.warn}>{m.ollamaModel}</Text>
    ) : (
      m.cliDefault
    )
  return [
    <Text>
      {m.reviewsWith}{' '}
      <Text bold color={colors.accent}>
        {PROVIDER_NAMES[provider]}
      </Text>
      {' · '}
      {modelText}
    </Text>,
    <Text color={colors.soft}>
      {origin.kind === 'user-config'
        ? m.from(shortenHome(oneLine(origin.path), home))
        : m.fromDefault}
    </Text>,
    ...wrapText(m.perRepo, width).map((line) => <Text color={colors.dim}>{line}</Text>),
  ]
}

function providerLines(checked: DataState<ProviderReport>, draw: Draw): ReactNode[] {
  const { messages, theme } = draw
  const { colors } = theme
  const m = messages.provider
  const header = <Text bold>{m.providers}</Text>
  if (checked.status === 'loading') return [header, <Text color={colors.dim}>{m.checking}</Text>]
  if (checked.status === 'failed') {
    return [
      header,
      <Text color={colors.error}>{messages.failed(errorMessage(checked.error))}</Text>,
    ]
  }
  const nameWidth = Math.max(...Object.values(PROVIDER_NAMES).map(textWidth))
  const chosenWidth = textWidth(m.chosen)
  return [
    header,
    ...checked.value.providers.flatMap((status) => {
      const models = modelsOf(status)
      return [
        <Text bold={status.chosen}>
          {stateIcon(status, theme)} {fit(PROVIDER_NAMES[status.provider], nameWidth)}
          {'  '}
          <Text color={colors.accent}>{fit(status.chosen ? m.chosen : '', chosenWidth)}</Text>
          {'  '}
          {statusParts(status, messages).join(' · ')}
        </Text>,
        ...(models.length === 0
          ? []
          : [
              <Text color={colors.dim}>
                {'    '}
                {m.models(models.length, names(models))}
              </Text>,
            ]),
        ...(status.next === null
          ? []
          : [
              <Text>
                {'    → '}
                {m.steps[status.next.kind]}{' '}
                <Text bold color={colors.accent}>
                  {oneLine(status.next.command)}
                </Text>
              </Text>,
            ]),
      ]
    }),
  ]
}

function mcpLines({ mcp }: ProviderSetup, draw: Draw): ReactNode[] {
  const { colors } = draw.theme
  const m = draw.messages.provider
  if (mcp.length === 0) return [<Text color={colors.dim}>{m.mcpNone}</Text>]
  const nameWidth = Math.min(
    Math.max(...mcp.map(({ name }) => textWidth(oneLine(name)))),
    MAX_MCP_NAME,
  )
  return [
    <Text bold>{m.mcp(mcp.length)}</Text>,
    ...mcp.map((server) => (
      <Text>
        {'  '}
        <Text color={colors.soft}>{fit(oneLine(server.name), nameWidth)}</Text>
        {'  '}
        {[
          m.mcpKinds[server.kind],
          ...(server.tools.length === 0 ? [] : [m.tools(server.tools.map(oneLine).join(', '))]),
          ...(server.description === null ? [] : [oneLine(server.description)]),
        ].join(' · ')}
      </Text>
    )),
  ]
}

function statusParts(status: ReportedProvider, messages: UiMessages): string[] {
  const m = messages.provider
  if (status.provider === 'ollama') {
    const { server } = status
    const state =
      server.state === 'running'
        ? [
            m.running(server.version === null ? null : oneLine(server.version)),
            ...(server.models.length === 0 ? [m.noModels] : []),
          ]
        : server.state === 'stopped'
          ? [m.stopped]
          : [m.serverUnknown(m.problems[server.problem])]
    return [...state, ...(status.baseUrl === null ? [] : [oneLine(status.baseUrl)])]
  }
  const { install, login } = status
  if (install.state === 'missing') return [m.notInstalled]
  const installPart =
    install.state === 'installed'
      ? m.installed(install.version === null ? null : oneLine(install.version))
      : m.installUnknown(m.problems[install.problem])
  if (login.state === 'logged-in') {
    return [installPart, m.loggedIn(login.method === null ? null : oneLine(login.method))]
  }
  if (login.state === 'logged-out') return [installPart, m.loggedOut]
  return login.problem === 'not-installed'
    ? [installPart]
    : [installPart, m.loginUnknown(m.problems[login.problem])]
}

function stateIcon(status: ReportedProvider, { colors }: Theme): ReactNode {
  if (status.next !== null) return <Text color={colors.warn}>○</Text>
  const ready =
    status.provider === 'ollama'
      ? status.server.state === 'running'
      : status.install.state === 'installed' && status.login.state === 'logged-in'
  return ready ? <Text color={colors.ok}>●</Text> : <Text color={colors.dim}>?</Text>
}

function modelsOf(status: ReportedProvider): string[] {
  return status.provider === 'ollama' && status.server.state === 'running'
    ? status.server.models.map(oneLine)
    : []
}

function names(values: readonly string[]): string {
  const shown = values.slice(0, MODELS_SHOWN).join(', ')
  return values.length > MODELS_SHOWN ? `${shown} +${values.length - MODELS_SHOWN}` : shown
}
