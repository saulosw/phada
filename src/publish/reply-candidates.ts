import type {
  PullRequestReviewState,
  ReviewThread,
  ThreadComment,
} from '../github/pull-request-reviews.js'
import { replyKindOf } from './markers.js'
import { isPhadaComment, openPhadaThreads } from './phada-state.js'

export type RepliesMode = 'auto' | 'mention' | 'off'

export interface ReplyOptions {
  mode: RepliesMode
  classified: ReadonlySet<string>
}

export interface ThreadToReply {
  thread: ReviewThread
  comments: ThreadComment[]
}

export const MAX_PHADA_REPLIES = 3

const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
const MENTION = /(?<![\w/.-])\/phada(?![\w-])/i

export function threadsToReply(
  state: PullRequestReviewState,
  options: ReplyOptions,
): ThreadToReply[] {
  if (options.mode === 'off' || state.pullState !== 'open') return []
  return openPhadaThreads(state).flatMap((thread) => {
    if (phadaReplies(state, thread) >= MAX_PHADA_REPLIES) return []
    const comments = newComments(state, thread).filter(
      (comment) =>
        comment.id !== undefined &&
        !options.classified.has(comment.id) &&
        fromPerson(state, comment),
    )
    if (comments.length === 0) return []
    if (options.mode === 'mention' && !comments.some((comment) => MENTION.test(comment.body))) {
      return []
    }
    return [{ thread, comments }]
  })
}

function newComments(state: PullRequestReviewState, thread: ReviewThread): ThreadComment[] {
  const lastOfPhada = thread.replies.findLastIndex((reply) => isPhadaComment(state, reply))
  return thread.replies.slice(lastOfPhada + 1)
}

function phadaReplies(state: PullRequestReviewState, thread: ReviewThread): number {
  return thread.replies.filter(
    (reply) => isPhadaComment(state, reply) && replyKindOf(reply.body) !== undefined,
  ).length
}

function fromPerson(state: PullRequestReviewState, comment: ThreadComment): boolean {
  if (comment.bot || comment.author === '') return false
  return (
    comment.author === state.viewer ||
    comment.author === state.author ||
    TRUSTED_ASSOCIATIONS.has(comment.association ?? '')
  )
}
