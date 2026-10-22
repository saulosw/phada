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

const REVIEWS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      state
      reviews(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id body author { login } commit { oid } }
      }
    }
  }
}`

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 1) {
            nodes {
              url
              body
              author { login }
              pullRequestReview { id }
              reactionGroups { content reactors { totalCount } }
            }
          }
          replies: comments(last: 20) { nodes { body author { login __typename } } }
        }
      }
    }
  }
}`

export interface PublishedReview {
  id: string
  author: string
  body: string
  commitSha: string | null
}

export interface ThreadComment {
  author: string
  body: string
  bot: boolean
}

export interface ReviewThread {
  id: string
  isResolved: boolean
  isOutdated: boolean
  path: string
  line: number | null
  url: string
  author: string
  body: string
  reviewId: string | null
  negativeReactions: number
  replies: ThreadComment[]
}

export type PullState = 'open' | 'closed' | 'merged'

export interface PullRequestReviewState {
  viewer: string
  pullState: PullState
  reviews: PublishedReview[]
  threads: ReviewThread[]
}

export interface FetchReviewStateOptions extends PullRequestRef {
  token: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

interface Page {
  data: unknown
  nodes: unknown[]
}

export async function fetchReviewState(
  options: FetchReviewStateOptions,
): Promise<PullRequestReviewState> {
  const { owner, repo, number } = options
  const ref = formatPullRequestRef({ owner, repo, number })
  const ctx: GitHubRequestContext = {
    token: options.token,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  const variables = { owner, repo, number }
  const reviewPages = await fetchPages(ctx, ref, REVIEWS_QUERY, variables, 'reviews')
  const threadPages = await fetchPages(ctx, ref, THREADS_QUERY, variables, 'reviewThreads')
  return {
    viewer: stringField(reviewPages[0]?.data, 'viewer.login'),
    pullState: pullStateOf(reviewPages[0]?.data),
    reviews: reviewPages.flatMap(({ nodes }) => nodes.map(toReview)),
    threads: threadPages.flatMap(({ nodes }) => nodes.map(toThread)),
  }
}

async function fetchPages(
  ctx: GitHubRequestContext,
  ref: string,
  query: string,
  variables: Record<string, unknown>,
  connection: string,
): Promise<Page[]> {
  const pages: Page[] = []
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
  return {
    id: stringField(node, 'id'),
    author: login(node, 'author'),
    body: stringField(node, 'body'),
    commitSha: field(node, 'commit') === null ? null : stringField(node, 'commit.oid'),
  }
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
    url: comment === undefined ? '' : stringField(comment, 'url'),
    author: comment === undefined ? '' : login(comment, 'author'),
    body: comment === undefined ? '' : stringField(comment, 'body'),
    reviewId:
      comment === undefined || field(comment, 'pullRequestReview') === null
        ? null
        : stringField(comment, 'pullRequestReview.id'),
    negativeReactions: comment === undefined ? 0 : negativeReactions(comment),
    replies: arrayField(node, 'replies.nodes').map((reply) => ({
      author: login(reply, 'author'),
      body: stringField(reply, 'body'),
      bot: field(reply, 'author') !== null && stringField(reply, 'author.__typename') === 'Bot',
    })),
  }
}

function negativeReactions(comment: unknown): number {
  return arrayField(comment, 'reactionGroups')
    .filter((group) => NEGATIVE_REACTIONS.has(stringField(group, 'content')))
    .reduce<number>((total, group) => total + numberField(group, 'reactors.totalCount'), 0)
}

function login(node: unknown, path: string): string {
  return field(node, path) === null ? '' : stringField(node, `${path}.login`)
}
