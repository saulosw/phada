import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import type { FakeCall, FakeResponse } from '../../test/support/fake-fetch.js'
import { GitHubGraphQLError, ThreadPermissionError } from './errors.js'
import { addThreadReply, isThreadOpen, replyAndResolve, resolveThread } from './resolve-thread.js'

const TOKEN = 'ghp_SECRET'
const byMutation = (call: FakeCall) => {
  const query = (JSON.parse(call.body ?? '{}') as { query: string }).query
  if (query.includes('resolveReviewThread')) return 'resolve'
  if (query.includes('addPullRequestReviewThreadReply')) return 'reply'
  return 'read'
}
const ok = (data: unknown): FakeResponse => ({ status: 200, body: JSON.stringify({ data }) })
const graphQLError = (error: Record<string, unknown>): FakeResponse => ({
  status: 200,
  body: JSON.stringify({ errors: [error] }),
})
const REPLIED = ok({
  addPullRequestReviewThreadReply: {
    comment: { id: 'C9', url: 'https://github.com/a/b/pull/1#discussion_r9' },
  },
})
const RESOLVED = ok({ resolveReviewThread: { thread: { id: 'PRRT_1', isResolved: true } } })
const FORBIDDEN = graphQLError({
  type: 'FORBIDDEN',
  message: 'Resource not accessible by personal access token',
})

function fakeGitHub(routes: {
  reply?: FakeResponse[]
  resolve?: FakeResponse[]
  read?: FakeResponse[]
}) {
  return createFakeFetch(
    { reply: routes.reply ?? [], resolve: routes.resolve ?? [], read: routes.read ?? [] },
    byMutation,
  )
}

const variablesOf = (call: FakeCall | undefined) =>
  (JSON.parse(call?.body ?? '{}') as { variables: unknown }).variables

describe('replyAndResolve', () => {
  it('resolves the thread and then replies on it', async () => {
    const { fetch, calls } = fakeGitHub({ reply: [REPLIED], resolve: [RESOLVED] })

    await replyAndResolve({ token: TOKEN, threadId: 'PRRT_1', body: 'Fixed in `abc1234`.', fetch })

    expect(calls.map(byMutation)).toEqual(['resolve', 'reply'])
    expect(variablesOf(calls[0])).toEqual({ threadId: 'PRRT_1' })
    expect(variablesOf(calls[1])).toEqual({ threadId: 'PRRT_1', body: 'Fixed in `abc1234`.' })
  })

  it('does not reply on a thread it could not resolve', async () => {
    const { fetch, calls } = fakeGitHub({
      resolve: [graphQLError({ message: 'Resource not accessible' })],
    })

    await expect(
      replyAndResolve({ token: TOKEN, threadId: 'PRRT_1', body: 'Fixed.', fetch }),
    ).rejects.toBeInstanceOf(GitHubGraphQLError)
    expect(calls).toHaveLength(1)
  })
})

describe('addThreadReply', () => {
  it('replies on the thread without resolving it and returns the new comment', async () => {
    const { fetch, calls } = fakeGitHub({ reply: [REPLIED] })

    const posted = await addThreadReply({
      token: TOKEN,
      threadId: 'PRRT_1',
      body: 'Because.',
      fetch,
    })

    expect(posted).toEqual({ id: 'C9', url: 'https://github.com/a/b/pull/1#discussion_r9' })
    expect(calls.map(byMutation)).toEqual(['reply'])
    expect(variablesOf(calls[0])).toEqual({ threadId: 'PRRT_1', body: 'Because.' })
  })

  it.each([
    ['a forbidden GraphQL error', FORBIDDEN],
    ['an HTTP 403', { status: 403, body: JSON.stringify({ message: 'Forbidden' }) }],
  ])('turns %s into a permission error', async (_name, answer) => {
    const { fetch } = fakeGitHub({ reply: [answer as FakeResponse] })

    const error = await addThreadReply({
      token: TOKEN,
      threadId: 'PRRT_1',
      body: 'x',
      fetch,
    }).catch((failure: unknown) => failure)

    expect(error).toBeInstanceOf(ThreadPermissionError)
    expect((error as Error).message).toContain('Pull requests: Read and write')
    expect((error as Error).message).not.toContain(TOKEN)
  })
})

describe('resolveThread', () => {
  it('resolves the thread', async () => {
    const { fetch, calls } = fakeGitHub({ resolve: [RESOLVED] })

    await resolveThread({ token: TOKEN, threadId: 'PRRT_1', fetch })

    expect(variablesOf(calls[0])).toEqual({ threadId: 'PRRT_1' })
  })

  it('turns a forbidden answer into a permission error', async () => {
    const { fetch } = fakeGitHub({ resolve: [FORBIDDEN] })

    await expect(resolveThread({ token: TOKEN, threadId: 'PRRT_1', fetch })).rejects.toBeInstanceOf(
      ThreadPermissionError,
    )
  })
})

describe('isThreadOpen', () => {
  it.each([
    [false, true],
    [true, false],
  ])('reads a thread resolved: %s as open: %s', async (isResolved, open) => {
    const { fetch, calls } = fakeGitHub({ read: [ok({ node: { isResolved } })] })

    expect(await isThreadOpen({ token: TOKEN, threadId: 'PRRT_1', fetch })).toBe(open)
    expect(variablesOf(calls[0])).toEqual({ threadId: 'PRRT_1' })
  })

  it('reads a thread that no longer exists as closed', async () => {
    const gone = fakeGitHub({ read: [ok({ node: null })] })
    const notFound = fakeGitHub({
      read: [graphQLError({ type: 'NOT_FOUND', message: 'Could not resolve to a node' })],
    })

    expect(await isThreadOpen({ token: TOKEN, threadId: 'PRRT_1', fetch: gone.fetch })).toBe(false)
    expect(await isThreadOpen({ token: TOKEN, threadId: 'PRRT_1', fetch: notFound.fetch })).toBe(
      false,
    )
  })
})
