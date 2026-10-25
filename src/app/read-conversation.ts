import type { PullComment, PullRequestReviewState } from '../github/pull-request-reviews.js'
import { buildConversation } from '../publish/conversation.js'
import type { Conversation } from '../publish/types.js'
import { errorMessage } from './error-message.js'

export async function readConversation(
  state: PullRequestReviewState,
  author: string,
  readComments: () => Promise<PullComment[]>,
  warn: (message: string) => void,
): Promise<Conversation> {
  let comments: PullComment[] = []
  try {
    comments = await readComments()
  } catch (error) {
    warn(`Pull request comments were not read: ${errorMessage(error)}`)
  }
  return buildConversation({ state, comments, author })
}
