import type {
  PullRequestReviewState,
  ReviewThread,
  ThreadComment,
} from '../../src/github/pull-request-reviews.js'

export function reviewThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 'T1',
    isResolved: false,
    isOutdated: false,
    path: 'src/app.ts',
    line: 10,
    url: '',
    author: 'me',
    body: '',
    reviewId: null,
    negativeReactions: 0,
    replies: [],
    ...overrides,
  }
}

export function reviewState(
  overrides: Partial<PullRequestReviewState> = {},
): PullRequestReviewState {
  return { viewer: 'me', pullState: 'open', reviews: [], threads: [], ...overrides }
}

export function threadReply(author: string, body: string, bot = false): ThreadComment {
  return { author, body, bot }
}
