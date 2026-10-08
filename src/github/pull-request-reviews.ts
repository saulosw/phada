import { GitHubGraphQLError, PullRequestNotFoundError } from './errors.js'
import { sendGraphQL } from './graphql.js'
import {
  arrayField,
  booleanField,
  field,
  invalidPayload,
  nullableNumberField,
  nullableStringField,
  stringField,
} from './json-fields.js'
import { formatPullRequestRef } from './pull-request-ref.js'
import type { PullRequestRef } from './pull-request-ref.js'
import type { GitHubRequestContext } from './request.js'

const DEFAULT_TIMEOUT_MS = 30_000

const REVIEWS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
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
          isResolved
          path
          line
          comments(first: 1) { nodes { body author { login } pullRequestReview { id } } }
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

export interface ReviewThread {
  isResolved: boolean
  path: string
  line: number | null
  author: string
  body: string
  reviewId: string | null
}

export interface PullRequestReviewState {
  viewer: string
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

function toThread(node: unknown): ReviewThread {
  const [comment] = arrayField(node, 'comments.nodes')
  return {
    isResolved: booleanField(node, 'isResolved'),
    path: stringField(node, 'path'),
    line: nullableNumberField(node, 'line'),
    author: comment === undefined ? '' : login(comment, 'author'),
    body: comment === undefined ? '' : stringField(comment, 'body'),
    reviewId:
      comment === undefined || field(comment, 'pullRequestReview') === null
        ? null
        : stringField(comment, 'pullRequestReview.id'),
  }
}

function login(node: unknown, path: string): string {
  return field(node, path) === null ? '' : stringField(node, `${path}.login`)
}
