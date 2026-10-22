import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import type { FakeCall, FakeResponse } from '../../test/support/fake-fetch.js'
import { GitHubGraphQLError } from './errors.js'
import { replyAndResolve } from './resolve-thread.js'

const byMutation = (call: FakeCall) => {
  const query = (JSON.parse(call.body ?? '{}') as { query: string }).query
  return query.includes('resolveReviewThread') ? 'resolve' : 'reply'
}
const ok = (data: unknown): FakeResponse => ({ status: 200, body: JSON.stringify({ data }) })

function run(reply: FakeResponse[], resolve: FakeResponse[] = []) {
  const fake = createFakeFetch({ reply, resolve }, byMutation)
  const result = replyAndResolve({
    token: 'ghp_SECRET',
    threadId: 'PRRT_1',
    body: 'Fixed in `abc1234`.',
    fetch: fake.fetch,
  })
  return { result, calls: fake.calls }
}

describe('replyAndResolve', () => {
  it('resolves the thread and then replies on it', async () => {
    const { result, calls } = run(
      [ok({ addPullRequestReviewThreadReply: { comment: { id: 'C1' } } })],
      [ok({ resolveReviewThread: { thread: { id: 'PRRT_1', isResolved: true } } })],
    )

    await result

    expect(calls.map(byMutation)).toEqual(['resolve', 'reply'])
    expect(JSON.parse(calls[0]?.body ?? '').variables).toEqual({ threadId: 'PRRT_1' })
    expect(JSON.parse(calls[1]?.body ?? '').variables).toEqual({
      threadId: 'PRRT_1',
      body: 'Fixed in `abc1234`.',
    })
  })

  it('does not reply on a thread it could not resolve', async () => {
    const { result, calls } = run(
      [],
      [{ status: 200, body: JSON.stringify({ errors: [{ message: 'Resource not accessible' }] }) }],
    )

    await expect(result).rejects.toBeInstanceOf(GitHubGraphQLError)
    expect(calls).toHaveLength(1)
  })
})
