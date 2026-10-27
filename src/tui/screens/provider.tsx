import { Text } from 'ink'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ProviderReport, ProviderSetup, ReportedProvider } from '../../app/read-provider.js'
import {
  useAppDeps,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useScreenSize,
  useTheme,
} from '../app-context.js'
import { useLoaded, usePolled } from '../data-hooks.js'
import type { DataState } from '../data-hooks.js'
import { failedText } from '../data-view.js'
import { useHandOff } from '../hand-off.js'
import { LanguagePicker, languageName } from '../language-picker.js'
import { ProviderPicker } from '../provider-picker.js'
import type { HandOffOutcome } from '../hand-off.js'
import { PROVIDER_NAMES } from '../provider-names.js'
import {
  loginOutcomeLines,
  modelsLine,
  nextStepLine,
  stateIcon,
  statusParts,
} from '../provider-lines.js'
import type { LoginProvider } from '../provider-lines.js'
import type { UiMessages } from '../i18n/messages.js'
import { ScrollText } from '../scroll-list.js'
import { SubView } from '../sub-view.js'
import { textWidth } from '../tab-layout.js'
import type { Theme } from '../theme.js'
import { fit, oneLine, shortenHome, wrapText } from '../text-fit.js'

const MAX_MCP_NAME = 24

interface LoginAttempt {
  provider: LoginProvider
  outcome: HandOffOutcome
}

interface Draw {
  messages: UiMessages
  theme: Theme
  home: string
  width: number
}

type Mode = 'view' | 'change' | 'language'

export function ProviderScreen() {
  const messages = useMessages()
  const [mode, setMode] = useState<Mode>('view')
  const [returned, setReturned] = useState(false)
  const back = () => {
    setReturned(true)
    setMode('view')
  }
  if (mode === 'change') {
    return (
      <SubView onLeave={back}>
        <ProviderPicker intro={messages.provider.changeIntro} onSaved={back} />
      </SubView>
    )
  }
  if (mode === 'language') {
    return (
      <SubView onLeave={back}>
        <LanguagePicker onDone={back} />
      </SubView>
    )
  }
  return <ProviderView checkAgain={returned} onEdit={setMode} />
}

function ProviderView({
  checkAgain,
  onEdit,
}: {
  checkAgain: boolean
  onEdit(mode: Exclude<Mode, 'view'>): void
}) {
  const { readProviderSetup, readProviders, readLanguage, home } = useAppDeps()
  const messages = useMessages()
  const theme = useTheme()
  const size = useScreenSize()
  const setup = usePolled(readProviderSetup)
  const language = usePolled(readLanguage)
  const { state: checked, reload } = useLoaded('providers', readProviders)
  const handOff = useHandOff()
  const [login, setLogin] = useState<LoginAttempt>()
  const target = checked.status === 'ready' ? loginTarget(checked.value) : undefined
  const editable = setup.status === 'ready'
  const checkedAgain = useRef(false)
  useEffect(() => {
    if (!checkAgain || checkedAgain.current) return
    checkedAgain.current = true
    reload()
  }, [checkAgain, reload])
  useScreenInput((input) => {
    if (handOff.running) return
    if (editable && input === 'c') return onEdit('change')
    if (editable && input === 'L') return onEdit('language')
    if (input !== 'l' || target === undefined) return
    setLogin(undefined)
    void handOff.run({ kind: 'ai-login', provider: target }).then((outcome) => {
      if (outcome === undefined) return
      reload()
      setLogin({ provider: target, outcome })
    })
  })
  const draw: Draw = { messages, theme, home, width: size.columns }
  const lines = [
    ...choiceLines(setup, draw),
    ...(language.status === 'ready'
      ? [
          <Text color={theme.colors.soft}>
            {messages.provider.language(oneLine(languageName(language.value)))}
          </Text>,
        ]
      : []),
    <Text> </Text>,
    ...providerLines(checked, draw),
    ...(login === undefined
      ? []
      : loginOutcomeLines(login.provider, login.outcome, messages, theme)),
    ...(setup.status === 'ready' ? [<Text> </Text>, ...mcpLines(setup.value, draw)] : []),
  ]
  useScreenKeys([
    ...(editable
      ? [
          { keys: 'c', label: messages.provider.change },
          { keys: 'L', label: messages.provider.languageKey },
        ]
      : []),
    { keys: 'r', label: messages.keys.refresh },
    ...(target === undefined
      ? []
      : [{ keys: 'l', label: messages.provider.logIn(PROVIDER_NAMES[target]) }]),
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
    return [<Text color={colors.error}>{failedText(messages, setup.error)}</Text>]
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
    return [header, <Text color={colors.error}>{failedText(messages, checked.error)}</Text>]
  }
  const nameWidth = Math.max(...Object.values(PROVIDER_NAMES).map(textWidth))
  const chosenWidth = textWidth(m.chosen)
  return [
    header,
    ...checked.value.providers.flatMap((status) => {
      return [
        <Text bold={status.chosen}>
          {stateIcon(status, theme)} {fit(PROVIDER_NAMES[status.provider], nameWidth)}
          {'  '}
          <Text color={colors.accent}>{fit(status.chosen ? m.chosen : '', chosenWidth)}</Text>
          {'  '}
          {statusParts(status, messages).join(' · ')}
        </Text>,
        ...modelsLine(status, messages, theme),
        ...nextStepLine(status, messages, theme),
      ]
    }),
  ]
}

function loginTarget({ providers }: ProviderReport): LoginProvider | undefined {
  const waiting = providers.flatMap((status) =>
    status.provider !== 'ollama' && status.next?.kind === 'login' ? [status] : [],
  )
  return (waiting.find(({ chosen }) => chosen) ?? waiting[0])?.provider
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
