import { Text } from 'ink'
import type { ReactNode } from 'react'
import { errorMessage } from '../app/error-message.js'
import type { ReportedProvider } from '../app/read-provider.js'
import type { HandOffOutcome } from './hand-off.js'
import type { UiMessages } from './i18n/messages.js'
import { PROVIDER_NAMES } from './provider-names.js'
import type { Theme } from './theme.js'
import { namesText, oneLine } from './text-fit.js'

export type LoginProvider = 'claude' | 'codex'

const MODELS_SHOWN = 5

export function statusParts(status: ReportedProvider, messages: UiMessages): string[] {
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

export function stateIcon(status: ReportedProvider, { colors }: Theme): ReactNode {
  if (status.next !== null) return <Text color={colors.warn}>○</Text>
  const ready =
    status.provider === 'ollama'
      ? status.server.state === 'running'
      : status.install.state === 'installed' && status.login.state === 'logged-in'
  return ready ? <Text color={colors.ok}>●</Text> : <Text color={colors.dim}>?</Text>
}

export function modelsLine(
  status: ReportedProvider,
  messages: UiMessages,
  { colors }: Theme,
): ReactNode[] {
  if (status.provider !== 'ollama' || status.server.state !== 'running') return []
  const { models } = status.server
  if (models.length === 0) return []
  return [
    <Text color={colors.dim}>
      {'    '}
      {messages.provider.models(models.length, namesText(models.map(oneLine), MODELS_SHOWN))}
    </Text>,
  ]
}

export function nextStepLine(
  status: ReportedProvider,
  messages: UiMessages,
  { colors }: Theme,
): ReactNode[] {
  if (status.next === null) return []
  return [
    <Text>
      {'    → '}
      {messages.provider.steps[status.next.kind]}{' '}
      <Text bold color={colors.accent}>
        {oneLine(status.next.command)}
      </Text>
    </Text>,
  ]
}

export function loginOutcomeLines(
  provider: LoginProvider,
  outcome: HandOffOutcome,
  messages: UiMessages,
  { colors }: Theme,
): ReactNode[] {
  switch (outcome.kind) {
    case 'exited':
      return outcome.exitCode === 0
        ? []
        : [
            <Text color={colors.warn}>
              {messages.provider.loginNotCompleted(PROVIDER_NAMES[provider])}
            </Text>,
          ]
    case 'not-found':
      return [
        <Text color={colors.warn}>{messages.handOff.notFound(oneLine(outcome.command))}</Text>,
      ]
    case 'failed':
      return [
        <Text color={colors.error}>
          {messages.handOff.failed(oneLine(errorMessage(outcome.error)))}
        </Text>,
      ]
  }
}
