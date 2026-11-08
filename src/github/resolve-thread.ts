import { GitHubAuthError, GitHubGraphQLError, ThreadPermissionError } from './errors.js'
import { sendGraphQL } from './graphql.js'
import { field, stringField } from './json-fields.js'
import type { GitHubRequestContext } from './request.js'

const DEFAULT_TIMEOUT_MS = 30_000

const REPLY = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id url }
  }
}`

const RESOLVE = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`

const THREAD_STATE = `query($threadId: ID!) {
  node(id: $threadId) { ... on PullRequestReviewThread { isResolved } }
}`

export interface ThreadOptions {
  token: string
  threadId: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export interface ReplyAndResolveOptions extends ThreadOptions {
  body: string
}

export interface PostedReply {
  id: string
  url: string
}

export async function replyAndResolve(options: ReplyAndResolveOptions): Promise<void> {
  await resolveThread(options)
  await addThreadReply(options)
}

export async function addThreadReply(options: ReplyAndResolveOptions): Promise<PostedReply> {
  const data = await writeThread(options, REPLY, { body: options.body })
  return {
    id: stringField(data, 'addPullRequestReviewThreadReply.comment.id'),
    url: stringField(data, 'addPullRequestReviewThreadReply.comment.url'),
  }
}

export async function resolveThread(options: ThreadOptions): Promise<void> {
  await writeThread(options, RESOLVE, {})
}

export async function isThreadOpen(options: ThreadOptions): Promise<boolean> {
  let data: unknown
  try {
    data = await sendGraphQL(contextOf(options), THREAD_STATE, { threadId: options.threadId })
  } catch (error) {
    if (error instanceof GitHubGraphQLError && error.type === 'NOT_FOUND') return false
    throw error
  }
  return field(data, 'node.isResolved') === false
}

async function writeThread(
  options: ThreadOptions,
  mutation: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await sendGraphQL(contextOf(options), mutation, {
      threadId: options.threadId,
      ...variables,
    })
  } catch (error) {
    if (error instanceof GitHubGraphQLError && error.type === 'FORBIDDEN') {
      throw new ThreadPermissionError(error.apiMessage)
    }
    if (error instanceof GitHubAuthError && error.status === 403) {
      throw new ThreadPermissionError(error.apiMessage)
    }
    throw error
  }
}

function contextOf(options: ThreadOptions): GitHubRequestContext {
  return {
    token: options.token,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
}
