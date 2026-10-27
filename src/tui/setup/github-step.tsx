import { Text } from 'ink'
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { GitHubAccess } from '../../app/read-home.js'
import {
  useAppDeps,
  useMessages,
  useScreenInput,
  useScreenKeys,
  useScreenSize,
  useTheme,
} from '../app-context.js'
import type { HandOffTarget } from '../app-context.js'
import { useLoaded } from '../data-hooks.js'
import type { DataState } from '../data-hooks.js'
import { failedText } from '../data-view.js'
import { useHandOff } from '../hand-off.js'
import type { HandOffOutcome } from '../hand-off.js'
import { loginOutcomeLines } from '../login-lines.js'
import type { LoginDraw } from '../login-lines.js'
import type { UiMessages } from '../i18n/messages.js'
import { ScrollText } from '../scroll-list.js'
import { oneLine, wrapText } from '../text-fit.js'
import type { Theme } from '../theme.js'
import type { SetupStepProps } from './setup-steps.js'

const GH_LOGIN: HandOffTarget = { kind: 'command', command: 'gh', args: ['auth', 'login'] }

export function GitHubStep({ next }: SetupStepProps) {
  const { readGitHub } = useAppDeps()
  const messages = useMessages()
  const theme = useTheme()
  const size = useScreenSize()
  const { state, reload } = useLoaded('github', readGitHub)
  const handOff = useHandOff()
  const [login, setLogin] = useState<HandOffOutcome>()
  const offersLogin = state.status === 'ready' && needsGhLogin(state.value)
  useScreenInput((_input, key) => {
    if (!key.return || handOff.running || state.status === 'loading') return
    if (!offersLogin) return next()
    setLogin(undefined)
    void handOff.run(GH_LOGIN).then((outcome) => {
      if (outcome === undefined) return
      reload()
      setLogin(outcome)
    })
  })
  const m = messages.setup
  const lines = [
    ...accessLines(state, messages, theme, size.columns),
    ...loginLines(login, { messages, theme, width: size.columns }),
  ]
  useScreenKeys([
    ...(state.status === 'loading'
      ? []
      : [{ keys: 'Enter', label: offersLogin ? m.github.logIn : m.continue }]),
    { keys: 'r', label: messages.keys.refresh },
  ])
  return <ScrollText lines={lines} rows={size.rows} />
}

function needsGhLogin(access: GitHubAccess): boolean {
  return access.source === null || (access.source === 'gh' && access.account.state === 'refused')
}

function accessLines(
  state: DataState<GitHubAccess>,
  messages: UiMessages,
  { colors }: Theme,
  width: number,
): ReactNode[] {
  const m = messages.setup.github
  const wrapped = (text: string, color?: string) =>
    wrapText(text, width).map((line) => <Text color={color}>{line}</Text>)
  if (state.status === 'loading') return [<Text color={colors.dim}>{m.checking}</Text>]
  if (state.status === 'failed') {
    return wrapped(failedText(messages, state.error), colors.error)
  }
  const access = state.value
  if (access.source === null) {
    return [<Text color={colors.warn}>○ {m.noToken}</Text>, <Text> </Text>, ...wrapped(m.why)]
  }
  const source = messages.home.github.sources[access.source]
  const { account } = access
  switch (account.state) {
    case 'found':
      return [
        <Text>
          <Text color={colors.ok}>●</Text> {m.found(source, oneLine(account.login))}
        </Text>,
        ...wrapped(m.readsAs(oneLine(account.login)), colors.soft),
      ]
    case 'refused':
      return [
        <Text color={colors.error}>○ {m.refused(source)}</Text>,
        ...(access.source === 'gh' ? [] : wrapped(m.replace(access.source), colors.soft)),
      ]
    case 'failed':
      return wrapped(`○ ${m.unreachable(oneLine(account.error))}`, colors.error)
  }
}

function loginLines(login: HandOffOutcome | undefined, draw: LoginDraw): ReactNode[] {
  if (login === undefined) return []
  const lines = loginOutcomeLines('gh', login, draw, draw.messages.setup.github.notInstalled)
  return lines.length === 0 ? [] : [<Text> </Text>, ...lines]
}
