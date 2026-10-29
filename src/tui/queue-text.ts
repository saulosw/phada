import type { QueueView } from '../app/read-queue.js'
import type { UiMessages } from './i18n/messages.js'
import { namesText } from './text-fit.js'

const NAMES_SHOWN = 3

type PauseReason = NonNullable<QueueView['pause']>['reason']

export function checkNames(names: readonly string[]): string {
  return namesText(names, NAMES_SHOWN)
}

export function pendingText(pending: readonly string[], messages: UiMessages): string {
  const q = messages.queue
  return pending.length === 0 ? q.noChecks : q.pending(pending.length, checkNames(pending))
}

export function pauseReasonText(reason: PauseReason, messages: UiMessages): string {
  const reasons = messages.queue.pauseReasons
  return reason === 'rate-limit' ? reasons.rateLimit : reasons.usageLimit
}
