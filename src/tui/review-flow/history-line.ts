import type { HistorySave } from '../../app/requested-review.js'
import type { UiMessages } from '../i18n/messages.js'
import { oneLine } from '../text-fit.js'

export function historyLine(history: HistorySave, messages: UiMessages): string {
  const m = messages.reviewFlow.history
  if (history.status === 'off') return m.off
  if (history.status === 'not-saved') return m.notSaved(oneLine(history.error))
  return history.feedbackError === undefined
    ? m.saved
    : m.feedbackNotSaved(oneLine(history.feedbackError))
}
