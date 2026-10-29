import type { ListedRun, RunRecord } from '../app/read-history.js'
import type { ReviewSource, UiMessages } from './i18n/messages.js'
import type { Theme } from './theme.js'

export function runKey(run: ListedRun): string {
  return String(run.id ?? `${run.repo}#${run.number}@${run.startedAt}`)
}

export function verdictLabel(run: RunRecord, messages: UiMessages): string {
  return run.verdict === undefined
    ? messages.reviews.statuses[run.status]
    : messages.reviews.verdicts[run.verdict]
}

export function verdictColor(
  run: Pick<RunRecord, 'verdict' | 'status'> | null,
  { colors }: Theme,
): string | undefined {
  const verdict = run?.verdict ?? (run?.status === 'failed' ? 'failed' : undefined)
  if (verdict === 'clean') return colors.ok
  if (verdict === 'comments') return colors.warn
  if (verdict === 'blocking' || verdict === 'failed') return colors.error
  return colors.dim
}

export function sourceOf(run: ListedRun): ReviewSource {
  return run.requestSource ?? run.source
}
