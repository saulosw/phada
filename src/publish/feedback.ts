import type { PullRequestReviewState, ReviewThread } from '../github/pull-request-reviews.js'
import type { Severity } from '../review/types.js'
import { findingSeverity, findingTitle, hasFindingMarker, hasResolvedMarker } from './markers.js'
import { phadaThreads, resolvedByPhada, reviewedShaOf } from './phada-state.js'
import { normalizeTitle } from './plan-publication.js'

export type Destination = 'fixed' | 'dismissed' | 'ignored' | 'open'
export type SignalKind = 'fixed' | 'dismissed' | 'ignored' | 'negative-reaction' | 'human-reply'

export interface ThreadFeedback {
  threadId: string
  fingerprint: string
  url: string
  file: string
  line: number | null
  title: string
  severity?: Severity
  commitSha: string | null
  outdated: boolean
  destination: Destination
  signals: SignalKind[]
}

const DESTINATIONS = ['fixed', 'dismissed', 'ignored'] as const

export function threadFeedback(state: PullRequestReviewState): ThreadFeedback[] {
  return phadaThreads(state).map((thread) => {
    const title = unescapeTitle(findingTitle(thread.body) ?? thread.path)
    const severity = findingSeverity(thread.body)
    const destination = destinationOfThread(state, thread)
    return {
      threadId: thread.id,
      fingerprint: findingFingerprint(thread.path, title),
      url: thread.url,
      file: thread.path,
      line: thread.line,
      title,
      ...(severity === undefined ? {} : { severity }),
      commitSha: reviewedShaOf(state, thread),
      outdated: thread.isOutdated,
      destination,
      signals: [
        ...(destination === 'open' ? [] : [destination]),
        ...(thread.negativeReactions > 0 ? ['negative-reaction' as const] : []),
        ...(hasHumanReply(state, thread) ? ['human-reply' as const] : []),
      ],
    }
  })
}

export function destinationOf(kinds: readonly SignalKind[]): Destination {
  return DESTINATIONS.find((destination) => kinds.includes(destination)) ?? 'open'
}

export function findingFingerprint(file: string, title: string): string {
  return `${file}:${normalizeTitle(title)}`
}

function unescapeTitle(title: string): string {
  return title
    .replace(/\u200b/g, '')
    .replace(/(\\+)</g, (escaped, slashes: string) =>
      slashes.length % 2 === 1 ? `${'\\'.repeat((slashes.length - 1) / 2)}<` : escaped,
    )
}

function destinationOfThread(state: PullRequestReviewState, thread: ReviewThread): Destination {
  if (thread.isResolved) {
    return resolvedByPhada(state, thread) || thread.isOutdated ? 'fixed' : 'dismissed'
  }
  return state.pullState === 'open' ? 'open' : 'ignored'
}

function hasHumanReply(state: PullRequestReviewState, thread: ReviewThread): boolean {
  return thread.replies.some((reply) => {
    if (reply.bot) return false
    const own = reply.author === state.viewer
    return !(own && (hasFindingMarker(reply.body) || hasResolvedMarker(reply.body)))
  })
}
