import { GitHubGraphQLError } from './errors.js'
import { isRecord } from './json-fields.js'
import { ACCEPT_JSON, ensureOk, readJson, sendGitHubRequest, toErrorSnippet } from './request.js'
import type { GitHubRequestContext } from './request.js'

export async function sendGraphQL(
  ctx: GitHubRequestContext,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const response = await sendGitHubRequest(ctx, '/graphql', ACCEPT_JSON, {
    method: 'POST',
    body: JSON.stringify({ query, variables }),
  })
  await ensureOk(response, ctx)
  const json = await readJson(response, ctx)
  const errors = isRecord(json) ? json.errors : undefined
  if (Array.isArray(errors) && errors.length > 0) throw toGraphQLError(errors[0], ctx.token)
  return isRecord(json) ? json.data : undefined
}

function toGraphQLError(error: unknown, token: string): GitHubGraphQLError {
  const message =
    isRecord(error) && typeof error.message === 'string' ? error.message : 'unknown error'
  const type = isRecord(error) && typeof error.type === 'string' ? error.type : undefined
  return new GitHubGraphQLError(toErrorSnippet(message, token), type)
}
