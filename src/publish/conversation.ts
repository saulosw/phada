import type {
  PullComment,
  PullRequestReviewState,
  PublishedReview,
  ReviewThread,
  ThreadComment,
} from '../github/pull-request-reviews.js'
import type {
  ConversationItem,
  ConversationReply,
  ConversationReviewState,
  ConversationRole,
} from '../review/types.js'
import { byteLength, cutBytes } from '../context/byte-cut.js'
import { findingTitle, hasFindingMarker, hasResolvedMarker, parseReviewMarker } from './markers.js'
import type { Conversation } from './types.js'

export const CONVERSATION_BUDGET_BYTES = 16 * 1024
export const CONVERSATION_BODY_BYTES = 2 * 1024

const ROLES: Readonly<Record<string, ConversationRole>> = {
  OWNER: 'owner',
  MEMBER: 'member',
  COLLABORATOR: 'collaborator',
  CONTRIBUTOR: 'contributor',
  FIRST_TIME_CONTRIBUTOR: 'contributor',
  FIRST_TIMER: 'contributor',
}
const ALWAYS_SHOWN: ReadonlySet<string> = new Set(['approved', 'changes-requested'])

export interface ConversationInput {
  state: PullRequestReviewState
  comments: readonly PullComment[]
  author: string
}

interface Author {
  author: string
  bot?: boolean
  association?: string
}

export function buildConversation({ state, comments, author }: ConversationInput): Conversation {
  const cuts = { truncated: 0 }
  const roleOf = (who: Author): ConversationRole =>
    who.author !== '' && who.author === author
      ? 'author'
      : who.bot === true
        ? 'bot'
        : (ROLES[who.association ?? ''] ?? 'external')
  const body = (text: string): string => cutBytes(text, CONVERSATION_BODY_BYTES, cuts)
  const own = (who: string, text: string): boolean =>
    who !== '' &&
    who === state.viewer &&
    (parseReviewMarker(text) !== undefined || hasFindingMarker(text) || hasResolvedMarker(text))

  const items: ConversationItem[] = [
    ...comments.map((item): ConversationItem => ({
      kind: 'comment',
      at: item.createdAt,
      author: item.author,
      role: roleOf(item),
      body: body(item.body),
    })),
    ...state.reviews.flatMap((review) => reviewItem(review, own, roleOf, body)),
    ...state.threads.flatMap((thread) => threadItem(thread, own, roleOf, body)),
  ]
  const kept = withinBudget(chronological(items))
  return {
    items: kept,
    report: {
      items: kept.length,
      omitted: items.length - kept.length,
      resolved: kept.filter((item) => item.kind === 'thread' && item.resolved).length,
      bots: kept.filter((item) => item.role === 'bot').length,
      truncated: cuts.truncated,
      bytes: blockBytes(kept),
    },
  }
}

function reviewItem(
  review: PublishedReview,
  own: (who: string, text: string) => boolean,
  roleOf: (who: Author) => ConversationRole,
  body: (text: string) => string,
): ConversationItem[] {
  const { state } = review
  if (state === undefined || state === 'pending' || own(review.author, review.body)) return []
  const empty = review.body.trim() === ''
  if (empty && !ALWAYS_SHOWN.has(state)) return []
  return [
    {
      kind: 'review',
      at: review.createdAt ?? '',
      author: review.author,
      role: roleOf(review),
      state: state satisfies ConversationReviewState,
      ...(empty ? {} : { body: body(review.body) }),
    },
  ]
}

function threadItem(
  thread: ReviewThread,
  own: (who: string, text: string) => boolean,
  roleOf: (who: Author) => ConversationRole,
  body: (text: string) => string,
): ConversationItem[] {
  const phada = own(thread.author, thread.body)
  const others = thread.replies.filter((reply) => reply.id !== thread.commentId)
  const shown = others.filter((reply) => !own(reply.author, reply.body) && !(phada && reply.bot))
  if (phada && shown.length === 0) return []
  const omitted = Math.max(0, (thread.comments ?? 1) - 1 - others.length)
  const replies = shown.map((reply: ThreadComment): ConversationReply => ({
    at: reply.createdAt ?? '',
    author: reply.author,
    role: roleOf(reply),
    body: body(reply.body),
  }))
  return [
    {
      kind: 'thread',
      at: thread.createdAt ?? '',
      author: thread.author,
      role: phada ? 'phada' : roleOf(thread),
      file: thread.path,
      line: thread.line,
      resolved: thread.isResolved,
      outdated: thread.isOutdated,
      body: phada ? (findingTitle(thread.body) ?? '') : body(thread.body),
      ...(replies.length === 0 ? {} : { replies }),
      ...(omitted === 0 ? {} : { omittedReplies: omitted }),
    },
  ]
}

function chronological(items: readonly ConversationItem[]): ConversationItem[] {
  return [...items].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
}

function withinBudget(items: readonly ConversationItem[]): ConversationItem[] {
  const dropOrder = [
    ...items.filter((item) => item.kind === 'thread' && item.resolved),
    ...items.filter((item) => item.kind === 'thread' && !item.resolved && item.outdated),
    ...items,
  ]
  const kept = new Set(items)
  let bytes = blockBytes(items)
  for (const item of dropOrder) {
    if (bytes <= CONVERSATION_BUDGET_BYTES) break
    if (!kept.has(item)) continue
    kept.delete(item)
    bytes = blockBytes(items.filter((candidate) => kept.has(candidate)))
  }
  return items.filter((item) => kept.has(item))
}

export function conversationItemBytes(item: ConversationItem): number {
  return byteLength(JSON.stringify(item))
}

function conversationLines(items: readonly ConversationItem[]): string {
  return items.map((item) => JSON.stringify(item)).join('\n')
}

function blockBytes(items: readonly ConversationItem[]): number {
  return byteLength(conversationLines(items))
}
