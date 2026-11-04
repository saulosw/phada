import type { ReviewThread } from '../github/pull-request-reviews.js'

export function writtenLine(thread: Pick<ReviewThread, 'line' | 'originalLine'>): number | null {
  return thread.originalLine ?? thread.line
}
