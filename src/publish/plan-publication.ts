import type { PullRequestReviewState, ReviewThread } from '../github/pull-request-reviews.js'
import type { Finding } from '../review/types.js'
import { phadaThreads } from './phada-state.js'
import type { PublicationPlan } from './types.js'

const LINE_WINDOW = 3
const THREAD_TITLE = /^\*\*P[0-2]\*\* · (.+) · [^·]+ \d+$/

export function planPublication(
  findings: readonly Finding[],
  state: PullRequestReviewState,
): PublicationPlan {
  const threads = phadaThreads(state)
  const open = threads.filter((thread) => !thread.isResolved)
  const resolved = threads.filter((thread) => thread.isResolved)
  const plan: PublicationPlan = {
    comments: [],
    stillOpen: [],
    dismissed: [],
    openThreads: open.length,
  }
  for (const finding of findings) {
    const target = open.some((thread) => matches(thread, finding))
      ? plan.stillOpen
      : resolved.some((thread) => matches(thread, finding))
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
  const title = threadTitle(thread.body)
  return title !== undefined && title !== '' && title === normalizeTitle(finding.title)
}

function threadTitle(body: string): string | undefined {
  const firstLine = body.split('\n', 1)[0]?.trim() ?? ''
  const title = THREAD_TITLE.exec(firstLine)?.[1]
  return title === undefined ? undefined : normalizeTitle(title)
}
