import { Text } from 'ink'
import type { ReactNode } from 'react'
import { errorMessage } from '../app/error-message.js'
import type { ProviderChecks } from '../app/read-provider.js'
import type { Loaded } from './data-hooks.js'
import type { DrawContext } from './frame-lines.js'
import type { HandOffOutcome } from './hand-off.js'
import type { LoginProvider } from './provider-lines.js'
import { PROVIDER_NAMES } from './provider-names.js'
import { oneLine, wrapText } from './text-fit.js'

export interface AiLogin {
  provider: LoginProvider
  outcome: HandOffOutcome
}

export interface LoginJudgement {
  notFound?: string
  loggedIn?: boolean
}

export function aiLoginLines(
  login: AiLogin | undefined,
  checked: Loaded<ProviderChecks>,
  draw: DrawContext,
): ReactNode[] {
  if (login === undefined) return []
  const loggedIn = loggedInAfter(checked, login.provider)
  return loginOutcomeLines(PROVIDER_NAMES[login.provider], login.outcome, draw, {
    ...(loggedIn === undefined ? {} : { loggedIn }),
  })
}

export function loginOutcomeLines(
  name: string,
  outcome: HandOffOutcome,
  { messages, theme, width }: DrawContext,
  { notFound, loggedIn }: LoginJudgement = {},
): ReactNode[] {
  const { colors } = theme
  const lines = (text: string, color: string | undefined) =>
    wrapText(text, width).map((line) => <Text color={color}>{line}</Text>)
  switch (outcome.kind) {
    case 'exited':
      return (loggedIn ?? outcome.exitCode === 0)
        ? []
        : lines(messages.provider.loginNotCompleted(name), colors.warn)
    case 'not-found':
      return lines(notFound ?? messages.handOff.notFound(oneLine(outcome.command)), colors.warn)
    case 'failed':
      return lines(messages.handOff.failed(oneLine(errorMessage(outcome.error))), colors.error)
  }
}

function loggedInAfter(
  { state, loading }: Loaded<ProviderChecks>,
  provider: LoginProvider,
): boolean | undefined {
  if (loading || state.status !== 'ready') return undefined
  const status = state.value.providers.find((checked) => checked.provider === provider)
  if (status === undefined || !('login' in status)) return undefined
  if (status.login.state === 'logged-in') return true
  return status.login.state === 'logged-out' ? false : undefined
}
