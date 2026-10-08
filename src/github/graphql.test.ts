import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import type { FakeResponse } from '../../test/support/fake-fetch.js'
import { GitHubAuthError, GitHubGraphQLError, GitHubRequestError } from './errors.js'
import { sendGraphQL } from './graphql.js'
import { ACCEPT_JSON } from './request.js'

const TOKEN = 'ghp_SECRET_test_token'

function graphQL(answers: FakeResponse[]) {
  const fake = createFakeFetch({ [ACCEPT_JSON]: answers })
  return { ctx: { token: TOKEN, fetch: fake.fetch, timeoutMs: 1_000 }, calls: fake.calls }
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

describe('sendGraphQL', () => {
  it('posts the query and variables and returns data', async () => {
    const { ctx, calls } = graphQL([
      { status: 200, body: '{"data":{"viewer":{"login":"octocat"}}}' },
    ])

    const data = await sendGraphQL(ctx, 'query { viewer { login } }', { n: 1 })

    expect(data).toEqual({ viewer: { login: 'octocat' } })
    expect(calls[0]?.url).toBe('https://api.github.com/graphql')
    expect(calls[0]?.method).toBe('POST')
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
      query: 'query { viewer { login } }',
      variables: { n: 1 },
    })
  })

  it('throws the first GraphQL error of an HTTP 200, redacted, with its type', async () => {
    const body = JSON.stringify({
      data: null,
      errors: [{ type: 'NOT_FOUND', message: `bad ${TOKEN}` }, { message: 'second' }],
    })
    const { ctx } = graphQL([{ status: 200, body }])

    const error = await failureOf(sendGraphQL(ctx, 'query', {}))

    expect(error).toBeInstanceOf(GitHubGraphQLError)
    expect(error).toMatchObject({ type: 'NOT_FOUND', apiMessage: 'bad [REDACTED]' })
    expect((error as Error).message).toBe('GitHub GraphQL API error: bad [REDACTED]')
  })

  it('reports an error without a message as unknown', async () => {
    const { ctx } = graphQL([{ status: 200, body: '{"errors":[{}]}' }])

    const error = await failureOf(sendGraphQL(ctx, 'query', {}))

    expect((error as Error).message).toBe('GitHub GraphQL API error: unknown error')
    expect(error).toMatchObject({ type: undefined })
  })

  it('maps HTTP errors like the REST calls', async () => {
    const { ctx } = graphQL([{ status: 401, body: '{"message":"Bad credentials"}' }])

    expect(await failureOf(sendGraphQL(ctx, 'query', {}))).toBeInstanceOf(GitHubAuthError)
  })

  it('rejects an answer that is not JSON', async () => {
    const { ctx } = graphQL([{ status: 200, body: 'nope' }])

    expect(await failureOf(sendGraphQL(ctx, 'query', {}))).toBeInstanceOf(GitHubRequestError)
  })
})
