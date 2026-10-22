import type { PullRequestReviewState, ReviewThread } from '../github/pull-request-reviews.js'
import type { Finding } from '../review/types.js'
import { findingTitle } from './markers.js'
import { phadaThreads, resolvedByPhada } from './phada-state.js'
import type { PublicationPlan } from './types.js'

const LINE_WINDOW = 3

export function planPublication(
  findings: readonly Finding[],
  state: PullRequestReviewState,
  fixedThreadIds: ReadonlySet<string> = new Set(),
): PublicationPlan {
  const threads = phadaThreads(state)
  const fixed = threads.filter((thread) => fixedThreadIds.has(thread.id))
  const open = threads.filter((thread) => !thread.isResolved && !fixedThreadIds.has(thread.id))
  const dismissed = threads.filter((thread) => thread.isResolved && !resolvedByPhada(state, thread))
  const plan: PublicationPlan = {
    comments: [],
    stillOpen: [],
    dismissed: [],
    fixedAgain: [],
    fixedThreads: fixed.length,
    openThreads: open.length,
  }
  for (const finding of findings) {
    const target = fixed.some((thread) => sameTitle(thread, finding))
      ? plan.fixedAgain
      : open.some((thread) => matches(thread, finding))
        ? plan.stillOpen
        : dismissed.some((thread) => sameTitle(thread, finding))
          ? plan.dismissed
          : plan.comments
    target.push(finding)
  }
  return plan
}

export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function matches(thread: ReviewThread, finding: Finding): boolean {
  if (thread.path !== finding.file) return false
  if (thread.line !== null && Math.abs(thread.line - finding.line) <= LINE_WINDOW) return true
  return sameTitle(thread, finding)
}

function sameTitle(thread: ReviewThread, finding: Finding): boolean {
  if (thread.path !== finding.file) return false
  const title = threadTitle(thread.body)
  return title !== undefined && title !== '' && title === normalizeTitle(finding.title)
}

function threadTitle(body: string): string | undefined {
  const title = findingTitle(body)
  return title === undefined ? undefined : normalizeTitle(title)
}
