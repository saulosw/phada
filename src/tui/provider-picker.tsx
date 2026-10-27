import { Box, Text } from 'ink'
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { hasModel, SUGGESTED_OLLAMA_MODEL } from '../app/read-provider.js'
import type { ProviderChoiceView, ReportedProvider } from '../app/read-provider.js'
import type { UserConfigChange, UserConfigPlan } from '../config/user-config-edit.js'
import {
  useAppDeps,
  useBack,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useScreenSize,
  useTheme,
} from './app-context.js'
import type { KeyHint } from './app-context.js'
import { configChangeLines, useConfigChange } from './config-change.js'
import { useLoaded } from './data-hooks.js'
import { failedText } from './data-view.js'
import { useHandOff } from './hand-off.js'
import type { HandOffOutcome } from './hand-off.js'
import type { UiMessages } from './i18n/messages.js'
import { modelPullLines, useModelPull } from './model-pull.js'
import { loginOutcomeLines } from './login-lines.js'
import { modelsLine, nextStepLine, stateIcon, statusParts } from './provider-lines.js'
import type { LoginProvider } from './provider-lines.js'
import { PROVIDER_NAMES } from './provider-names.js'
import { ScrollList, ScrollText } from './scroll-list.js'
import { textWidth } from './tab-layout.js'
import { TextFieldLine, useTextField } from './text-field.js'
import type { Theme } from './theme.js'
import { fit, oneLine, wrapText } from './text-fit.js'
import { modelSizeText } from './units.js'

type ModelOption =
  | { kind: 'cli-default' }
  | { kind: 'installed'; name: string }
  | { kind: 'suggested'; name: string; bytes: number }
  | { kind: 'type' }

type Mode = 'providers' | 'models'

interface LoginAttempt {
  provider: LoginProvider
  outcome: HandOffOutcome
}

interface Draw {
  messages: UiMessages
  theme: Theme
  width: number
}

const CURSOR = '❯ '
const NO_CURSOR = '  '

export function ProviderPicker({
  intro,
  onSaved,
}: {
  intro: string
  onSaved(plan: UserConfigPlan): void
}) {
  const { readProviders, home } = useAppDeps()
  const messages = useMessages()
  const theme = useTheme()
  const size = useScreenSize()
  const { state: checked, reload } = useLoaded('providers', readProviders)
  const report = checked.status === 'ready' ? checked.value : undefined
  const providers = report?.providers ?? []
  const handOff = useHandOff()
  const [login, setLogin] = useState<LoginAttempt>()
  const [mode, setMode] = useState<Mode>('providers')
  const modeNow = useRef<Mode>('providers')
  const [providerPick, setProviderPick] = useState<number>()
  const providerNow = useRef<number | undefined>(undefined)
  const [modelPick, setModelPick] = useState<number>()
  const modelNow = useRef<number | undefined>(undefined)

  const chosenIndex = Math.max(
    providers.findIndex(({ chosen }) => chosen),
    0,
  )
  const providerAt = () => providerNow.current ?? chosenIndex
  const selected = providers[providerPick ?? chosenIndex]
  const options = selected === undefined || report === undefined ? [] : modelOptions(selected)
  const currentModel =
    selected === undefined || report === undefined
      ? -1
      : currentOption(options, selected, report.choice)
  const modelAt = () => modelNow.current ?? Math.max(currentModel, 0)

  const change = useConfigChange(onSaved)
  const pull = useModelPull((model) => {
    reload()
    change.propose(choose('ollama', model))
  })
  const field = useTextField({
    emptyOnFocus: true,
    onSubmit: (value) => {
      const name = value.trim()
      if (name === '' || selected === undefined) return
      if (selected.provider === 'ollama' && !hasModel(installedModels(selected), name)) {
        return pull.start(name)
      }
      change.propose(choose(selected.provider, name))
    },
  })

  const switchMode = (next: Mode) => {
    modeNow.current = next
    setMode(next)
    modelNow.current = undefined
    setModelPick(undefined)
    pull.clear()
  }
  const pickProvider = (index: number) => {
    providerNow.current = index
    setProviderPick(index)
    setLogin(undefined)
  }
  const pickModel = (index: number) => {
    modelNow.current = index
    setModelPick(index)
  }

  const busy = change.open || pull.pulling || handOff.running || field.focused
  useBack(
    change.open
      ? change.cancel
      : pull.pulling
        ? pull.cancel
        : mode === 'models'
          ? () => switchMode('providers')
          : undefined,
  )
  useScreenInput((_input, key) => {
    if (busy || report === undefined) return
    if (modeNow.current === 'providers') {
      const at = providerAt()
      if (key.upArrow) return pickProvider(Math.max(at - 1, 0))
      if (key.downArrow) return pickProvider(Math.min(at + 1, providers.length - 1))
      const status = providers[at]
      if (!key.return || status === undefined) return
      const action = providerAction(status)
      if (action === 'models') return switchMode('models')
      if (action === 'login' && status.provider !== 'ollama') logIn(status.provider)
      return
    }
    const at = modelAt()
    if (key.upArrow) return pickModel(Math.max(at - 1, 0))
    if (key.downArrow) return pickModel(Math.min(at + 1, options.length - 1))
    const option = options[at]
    if (!key.return || option === undefined || selected === undefined) return
    pull.clear()
    switch (option.kind) {
      case 'cli-default':
        return change.propose(choose(selected.provider, null))
      case 'installed':
        return change.propose(choose('ollama', option.name))
      case 'suggested':
        return pull.start(option.name)
      case 'type':
        return field.focus()
    }
  })

  const logIn = (provider: LoginProvider) => {
    setLogin(undefined)
    void handOff.run({ kind: 'ai-login', provider }).then((outcome) => {
      if (outcome === undefined) return
      reload()
      setLogin({ provider, outcome })
    })
  }

  const m = messages.provider.pick
  useScreenKeys(
    change.open
      ? change.keys
      : field.focused
        ? [
            { keys: 'Enter', label: messages.field.apply },
            { keys: 'Esc', label: messages.field.cancel },
          ]
        : pull.pulling
          ? [{ keys: 'Esc', label: m.cancelPull }]
          : mode === 'models'
            ? [
                { keys: '↑/↓', label: messages.keys.select },
                {
                  keys: 'Enter',
                  label: options[modelAt()]?.kind === 'suggested' ? m.pull : m.choose,
                },
                { keys: 'Esc', label: messages.keys.back },
              ]
            : [
                { keys: '↑/↓', label: messages.keys.select },
                ...providerKey(selected, messages),
                { keys: 'r', label: messages.keys.refresh },
              ],
  )

  const draw: Draw = { messages, theme, width: size.columns }
  const tail: ReactNode[] = [
    ...(field.focused ? [<TextFieldLine label={m.modelField} field={field} />] : []),
    ...spaced(modelPullLines(pull.state, draw)),
    ...spaced(configChangeLines(change.state, { ...draw, home })),
  ]
  const head: ReactNode[] = [
    ...wrapText(intro, size.columns).map((line) => <Text>{line}</Text>),
    <Text> </Text>,
  ]
  if (checked.status !== 'ready') {
    const state =
      checked.status === 'loading' ? (
        <Text color={theme.colors.dim}>{messages.provider.checking}</Text>
      ) : (
        <Text color={theme.colors.error}>{failedText(messages, checked.error)}</Text>
      )
    return <ScrollText lines={[...head, state]} rows={size.rows} active={false} />
  }
  const nameWidth = Math.max(...Object.values(PROVIDER_NAMES).map(textWidth))
  if (mode === 'providers' || selected === undefined) {
    const lines = [
      ...head,
      ...providers.flatMap((status, index) =>
        providerRows(status, index === (providerPick ?? chosenIndex), nameWidth, draw),
      ),
      ...(selected !== undefined &&
      selected.provider === 'ollama' &&
      selected.server.state === 'stopped'
        ? [
            <Text> </Text>,
            ...wrapText(m.serveHint, size.columns).map((line) => <Text>{line}</Text>),
          ]
        : []),
      ...(login === undefined
        ? []
        : [
            <Text> </Text>,
            ...loginOutcomeLines(PROVIDER_NAMES[login.provider], login.outcome, draw),
          ]),
      ...tail,
    ]
    return <ScrollText lines={lines} rows={size.rows} active={false} />
  }
  const top: ReactNode[] = [
    ...head,
    <Text>
      {NO_CURSOR}
      {stateIcon(selected, theme)} {fit(PROVIDER_NAMES[selected.provider], nameWidth)}
      {'  '}
      {statusParts(selected, messages).join(' · ')}
    </Text>,
    <Text> </Text>,
    <Text bold>{m.modelFor(PROVIDER_NAMES[selected.provider])}</Text>,
  ]
  const room = Math.max(size.rows - top.length - tail.length, 2)
  return (
    <Box flexDirection="column">
      <Lines lines={top} />
      <ScrollList
        items={options}
        index={modelPick ?? modelAt()}
        rows={room}
        keyOf={optionKey}
        renderItem={(option) => optionText(option, options.indexOf(option) === currentModel, draw)}
      />
      <Lines lines={tail} />
    </Box>
  )
}

function Lines({ lines }: { lines: readonly ReactNode[] }) {
  return lines.map((line, index) => (
    <Text key={index} wrap="truncate-end">
      {line}
    </Text>
  ))
}

function providerAction(status: ReportedProvider): 'models' | 'login' | undefined {
  if (status.provider === 'ollama') {
    return status.server.state === 'running' ? 'models' : undefined
  }
  if (status.install.state === 'missing') return undefined
  return status.login.state === 'logged-out' ? 'login' : 'models'
}

function providerKey(status: ReportedProvider | undefined, messages: UiMessages): KeyHint[] {
  if (status === undefined) return []
  const action = providerAction(status)
  if (action === undefined) return []
  return [
    {
      keys: 'Enter',
      label:
        action === 'login'
          ? messages.provider.logIn(PROVIDER_NAMES[status.provider])
          : messages.provider.pick.choose,
    },
  ]
}

function providerRows(
  status: ReportedProvider,
  selected: boolean,
  nameWidth: number,
  { messages, theme }: Draw,
): ReactNode[] {
  const { colors } = theme
  const chosenWidth = textWidth(messages.provider.chosen)
  return [
    <Text bold={selected}>
      {selected ? <Text color={colors.accent}>{CURSOR}</Text> : NO_CURSOR}
      {stateIcon(status, theme)} {fit(PROVIDER_NAMES[status.provider], nameWidth)}
      {'  '}
      <Text color={colors.accent}>
        {fit(status.chosen ? messages.provider.chosen : '', chosenWidth)}
      </Text>
      {'  '}
      {statusParts(status, messages).join(' · ')}
    </Text>,
    ...modelsLine(status, messages, theme),
    ...(status.next?.kind === 'pull' ? [] : nextStepLine(status, messages, theme)),
  ]
}

function modelOptions(status: ReportedProvider): ModelOption[] {
  if (status.provider !== 'ollama') return [{ kind: 'cli-default' }, { kind: 'type' }]
  const models = installedModels(status)
  return [
    ...(models.length === 0
      ? [{ kind: 'suggested' as const, ...SUGGESTED_OLLAMA_MODEL }]
      : models.map((name) => ({ kind: 'installed' as const, name }))),
    { kind: 'type' },
  ]
}

function currentOption(
  options: readonly ModelOption[],
  status: ReportedProvider,
  choice: ProviderChoiceView,
): number {
  if (choice.provider !== status.provider) return -1
  return options.findIndex((option) =>
    option.kind === 'cli-default'
      ? choice.model === null
      : option.kind === 'installed' &&
        choice.model !== null &&
        hasModel([option.name], choice.model),
  )
}

function optionKey(option: ModelOption): string {
  return option.kind === 'installed' || option.kind === 'suggested'
    ? `${option.kind}:${option.name}`
    : option.kind
}

function optionText(option: ModelOption, current: boolean, { messages, theme }: Draw): ReactNode {
  const { colors } = theme
  const m = messages.provider.pick
  const [name, note] =
    option.kind === 'cli-default'
      ? [m.cliDefault, undefined]
      : option.kind === 'type'
        ? [m.typeModel, undefined]
        : option.kind === 'installed'
          ? [oneLine(option.name), m.installed]
          : [option.name, m.suggested(modelSizeText(option.bytes))]
  const notes = [...(note === undefined ? [] : [note]), ...(current ? [m.current] : [])]
  return (
    <>
      {name}
      {notes.length === 0 ? '' : <Text color={colors.dim}> · {notes.join(' · ')}</Text>}
    </>
  )
}

function installedModels(status: ReportedProvider): string[] {
  return status.provider === 'ollama' && status.server.state === 'running'
    ? status.server.models
    : []
}

function choose(provider: ReportedProvider['provider'], model: string | null): UserConfigChange[] {
  return [
    { kind: 'set', key: 'provider', value: provider },
    model === null ? { kind: 'unset', key: 'model' } : { kind: 'set', key: 'model', value: model },
  ]
}

function spaced(lines: ReactNode[]): ReactNode[] {
  return lines.length === 0 ? [] : [<Text> </Text>, ...lines]
}
