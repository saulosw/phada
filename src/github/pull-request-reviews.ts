import { GitHubGraphQLError, PullRequestNotFoundError } from './errors.js'
import { sendGraphQL } from './graphql.js'
import {
  arrayField,
  booleanField,
  field,
  invalidPayload,
  nullableNumberField,
  nullableStringField,
  numberField,
  stringField,
} from './json-fields.js'
import { formatPullRequestRef } from './pull-request-ref.js'
import type { PullRequestRef } from './pull-request-ref.js'
import type { GitHubRequestContext } from './request.js'

const DEFAULT_TIMEOUT_MS = 30_000
const NEGATIVE_REACTIONS = new Set(['THUMBS_DOWN', 'CONFUSED'])
const PULL_STATES: Readonly<Record<string, PullState>> = {
  OPEN: 'open',
  CLOSED: 'closed',
  MERGED: 'merged',
}
const REVIEW_STATES: Readonly<Record<string, ReviewState>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending',
}

const REVIEWS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      state
      author { login }
      reviews(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          body
          state
          createdAt
          submittedAt
          authorAssociation
          author { login __typename }
          url
          commit { oid }
        }
      }
    }
  }
}`

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          originalLine
          originalStartLine
          comments(first: 1) {
            nodes {
              id
              url
              body
              createdAt
              publishedAt
              authorAssociation
              author { login __typename }
              pullRequestReview { id }
              originalCommit { oid }
              reactionGroups { content reactors { totalCount } }
            }
          }
          replies: comments(last: 20) {
            totalCount
            nodes { id body createdAt publishedAt authorAssociation author { login __typename } }
          }
        }
      }
    }
  }
}`

const COMMENTS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      comments(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id body createdAt publishedAt authorAssociation author { login __typename } }
      }
    }
  }
}`

export type ReviewState = 'approved' | 'changes-requested' | 'commented' | 'dismissed' | 'pending'

export interface PublishedReview {
  id: string
  author: string
  body: string
  commitSha: string | null
  url?: string
  state?: ReviewState
  createdAt?: string
  association?: string
  bot?: boolean
}

export interface ThreadComment {
  author: string
  body: string
  bot: boolean
  id?: string
  createdAt?: string
  association?: string
}

export interface PullComment {
  id: string
  author: string
  bot: boolean
  association: string
  createdAt: string
  body: string
}

export interface ReviewThread {
  id: string
  isResolved: boolean
  isOutdated: boolean
  path: string
  line: number | null
  startLine?: number
  originalLine?: number
  originalStartLine?: number
  originalCommit?: string
  url: string
  author: string
  body: string
  reviewId: string | null
  negativeReactions: number
  replies: ThreadComment[]
  commentId?: string
  createdAt?: string
  association?: string
  bot?: boolean
  comments?: number
}

export type PullState = 'open' | 'closed' | 'merged'

export interface PullRequestReviewState {
  viewer: string
  pullState: PullState
  author?: string
  headSha: string
  reviews: PublishedReview[]
  threads: ReviewThread[]
}

export interface FetchReviewStateOptions extends PullRequestRef {
  token: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export interface PullRequestPage {
  data: unknown
  nodes: unknown[]
}

export async function fetchReviewState(
  options: FetchReviewStateOptions,
): Promise<PullRequestReviewState> {
  const reviewPages = await fetchPullRequestPages(options, REVIEWS_QUERY, 'reviews')
  const threadPages = await fetchPullRequestPages(options, THREADS_QUERY, 'reviewThreads')
  return {
    viewer: stringField(reviewPages[0]?.data, 'viewer.login'),
    pullState: pullStateOf(reviewPages[0]?.data),
    author: login(reviewPages[0]?.data, 'repository.pullRequest.author'),
    headSha: stringField(threadPages.at(-1)?.data, 'repository.pullRequest.headRefOid'),
    reviews: reviewPages.flatMap(({ nodes }) => nodes.map(toReview)),
    threads: threadPages.flatMap(({ nodes }) => nodes.map(toThread)),
  }
}

export async function fetchPullComments(options: FetchReviewStateOptions): Promise<PullComment[]> {
  const pages = await fetchPullRequestPages(options, COMMENTS_QUERY, 'comments')
  return pages.flatMap(({ nodes }) =>
    nodes.map((node) => ({
      id: stringField(node, 'id'),
      ...authorOf(node, 'author'),
      association: stringField(node, 'authorAssociation'),
      createdAt: shownAt(node, 'publishedAt'),
      body: stringField(node, 'body'),
    })),
  )
}

export async function fetchPullRequestPages(
  options: FetchReviewStateOptions,
  query: string,
  connection: string,
): Promise<PullRequestPage[]> {
  const { owner, repo, number } = options
  const ctx: GitHubRequestContext = {
    token: options.token,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  const ref = formatPullRequestRef({ owner, repo, number })
  const variables = { owner, repo, number }
  const pages: PullRequestPage[] = []
  let after: string | null = null
  do {
    const data = await queryPullRequest(ctx, ref, query, { ...variables, after })
    const root = field(data, `repository.pullRequest.${connection}`)
    pages.push({ data, nodes: arrayField(root, 'nodes') })
    after = nextCursor(root, connection)
  } while (after !== null)
  return pages
}

async function queryPullRequest(
  ctx: GitHubRequestContext,
  ref: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  let data: unknown
  try {
    data = await sendGraphQL(ctx, query, variables)
  } catch (error) {
    if (error instanceof GitHubGraphQLError && error.type === 'NOT_FOUND') {
      throw new PullRequestNotFoundError(ref)
    }
    throw error
  }
  if (field(data, 'repository.pullRequest') === null) throw new PullRequestNotFoundError(ref)
  return data
}

function nextCursor(root: unknown, connection: string): string | null {
  if (!booleanField(root, 'pageInfo.hasNextPage')) return null
  const cursor = nullableStringField(root, 'pageInfo.endCursor')
  if (cursor === null) throw invalidPayload(`${connection}.pageInfo.endCursor`)
  return cursor
}

function toReview(node: unknown): PublishedReview {
  const state = REVIEW_STATES[stringField(node, 'state')]
  if (state === undefined) throw invalidPayload('review.state')
  const { author, bot } = authorOf(node, 'author')
  return {
    id: stringField(node, 'id'),
    author,
    body: stringField(node, 'body'),
    commitSha: field(node, 'commit') === null ? null : stringField(node, 'commit.oid'),
    ...(typeof field(node, 'url') === 'string' ? { url: stringField(node, 'url') } : {}),
    state,
    createdAt: shownAt(node, 'submittedAt'),
    association: stringField(node, 'authorAssociation'),
    bot,
  }
}

function shownAt(node: unknown, published: 'submittedAt' | 'publishedAt'): string {
  return nullableStringField(node, published) ?? stringField(node, 'createdAt')
}

function pullStateOf(data: unknown): PullState {
  const state = PULL_STATES[stringField(data, 'repository.pullRequest.state')]
  if (state === undefined) throw invalidPayload('pullRequest.state')
  return state
}

function toThread(node: unknown): ReviewThread {
  const [comment] = arrayField(node, 'comments.nodes')
  return {
    id: stringField(node, 'id'),
    isResolved: booleanField(node, 'isResolved'),
    isOutdated: booleanField(node, 'isOutdated'),
    path: stringField(node, 'path'),
    line: nullableNumberField(node, 'line'),
    ...startLineOf(node),
    ...originalLines(node),
    url: comment === undefined ? '' : stringField(comment, 'url'),
    author: comment === undefined ? '' : login(comment, 'author'),
    body: comment === undefined ? '' : stringField(comment, 'body'),
    reviewId:
      comment === undefined || field(comment, 'pullRequestReview') === null
        ? null
        : stringField(comment, 'pullRequestReview.id'),
    negativeReactions: comment === undefined ? 0 : negativeReactions(comment),
    replies: arrayField(node, 'replies.nodes').map((reply) => ({
      id: stringField(reply, 'id'),
      ...authorOf(reply, 'author'),
      body: stringField(reply, 'body'),
      createdAt: shownAt(reply, 'publishedAt'),
      association: stringField(reply, 'authorAssociation'),
    })),
    ...(comment === undefined
      ? {}
      : {
          commentId: stringField(comment, 'id'),
          createdAt: shownAt(comment, 'publishedAt'),
          association: stringField(comment, 'authorAssociation'),
          bot: authorOf(comment, 'author').bot,
          ...(field(comment, 'originalCommit') === null
            ? {}
            : { originalCommit: stringField(comment, 'originalCommit.oid') }),
        }),
    comments: numberField(node, 'replies.totalCount'),
  }
}

function startLineOf(node: unknown): Pick<ReviewThread, 'startLine'> {
  const start = nullableNumberField(node, 'startLine')
  return start === null ? {} : { startLine: start }
}

function originalLines(node: unknown): Pick<ReviewThread, 'originalLine' | 'originalStartLine'> {
  const line = nullableNumberField(node, 'originalLine')
  const start = nullableNumberField(node, 'originalStartLine')
  return {
    ...(line === null ? {} : { originalLine: line }),
    ...(start === null ? {} : { originalStartLine: start }),
  }
}

function authorOf(node: unknown, path: string): { author: string; bot: boolean } {
  if (field(node, path) === null) return { author: '', bot: false }
  return {
    author: stringField(node, `${path}.login`),
    bot: stringField(node, `${path}.__typename`) === 'Bot',
  }
}

function negativeReactions(comment: unknown): number {
  if (field(comment, 'reactionGroups') === null) return 0
  return arrayField(comment, 'reactionGroups')
    .filter((group) => NEGATIVE_REACTIONS.has(stringField(group, 'content')))
    .reduce<number>((total, group) => total + numberField(group, 'reactors.totalCount'), 0)
}

function login(node: unknown, path: string): string {
  return field(node, path) === null ? '' : stringField(node, `${path}.login`)
}
