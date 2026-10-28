import type { SubmitResult } from '../app/submit-request.js'
import type { UiMessages } from './i18n/messages.js'
import { absoluteTime } from './relative-time.js'
import { oneLine } from './text-fit.js'

export function refusalText(
  refusal: Extract<SubmitResult, { status: 'refused' }>,
  messages: UiMessages,
): string {
  const r = messages.reviewFlow.enqueue.refusals
  switch (refusal.reason) {
    case 'not-watched':
      return r.notWatched
    case 'closed':
      return r.closed
    case 'external':
      return r.external
    case 'when-command':
      return r.whenCommand(refusal.message === undefined ? r.noReason : oneLine(refusal.message))
    case 'already-reviewed':
      return refusal.job === undefined ? r.alreadyReviewed : r.alreadyReviewedJob(refusal.job.id)
    case 'hourly-limit':
      return refusal.until === undefined
        ? r.hourlyLimit
        : r.hourlyLimitUntil(absoluteTime(refusal.until))
  }
}
