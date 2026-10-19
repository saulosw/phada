import { sendGraphQL } from './graphql.js'
import type { GitHubRequestContext } from './request.js'

const DEFAULT_TIMEOUT_MS = 30_000

const REPLY = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id }
  }
}`

const RESOLVE = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`

export interface ReplyAndResolveOptions {
  token: string
  threadId: string
  body: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

export async function replyAndResolve(options: ReplyAndResolveOptions): Promise<void> {
  const ctx: GitHubRequestContext = {
    token: options.token,
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
  await sendGraphQL(ctx, REPLY, { threadId: options.threadId, body: options.body })
  await sendGraphQL(ctx, RESOLVE, { threadId: options.threadId })
}
