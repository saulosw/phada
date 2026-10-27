import { Text } from 'ink'
import type { ReactNode } from 'react'
import { errorMessage } from '../app/error-message.js'
import type { HandOffOutcome } from './hand-off.js'
import type { UiMessages } from './i18n/messages.js'
import type { Theme } from './theme.js'
import { oneLine, wrapText } from './text-fit.js'

export interface LoginDraw {
  messages: UiMessages
  theme: Theme
  width: number
}

export function loginOutcomeLines(
  name: string,
  outcome: HandOffOutcome,
  { messages, theme, width }: LoginDraw,
  notFound?: string,
): ReactNode[] {
  const { colors } = theme
  const lines = (text: string, color: string | undefined) =>
    wrapText(text, width).map((line) => <Text color={color}>{line}</Text>)
  switch (outcome.kind) {
    case 'exited':
      return outcome.exitCode === 0
        ? []
        : lines(messages.provider.loginNotCompleted(name), colors.warn)
    case 'not-found':
      return lines(notFound ?? messages.handOff.notFound(oneLine(outcome.command)), colors.warn)
    case 'failed':
      return lines(messages.handOff.failed(oneLine(errorMessage(outcome.error))), colors.error)
  }
}
