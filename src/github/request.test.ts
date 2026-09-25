import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import type { FakeResponse } from '../../test/support/fake-fetch.js'
import { GitHubAuthError, GitHubRateLimitError, GitHubRequestError } from './errors.js'
import {
  ACCEPT_DIFF,
  ACCEPT_JSON,
  ensureOk,
  readJson,
  readText,
  redact,
  sendGitHubRequest,
  toErrorSnippet,
} from './request.js'
import type { GitHubRequestContext } from './request.js'

const TOKEN = 'ghp_SECRET_test_token'
const PATH = '/repos/saulosw/phada/pulls/12'

function contextWith(answers: FakeResponse[], timeoutMs = 1_000) {
  const fake = createFakeFetch({ [ACCEPT_JSON]: answers })
  const ctx: GitHubRequestContext = { token: TOKEN, fetch: fake.fetch, timeoutMs }
  return { ctx, calls: fake.calls }
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

// A body that fails while being read, like a connection dropped mid-response.
function brokenBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.error(new TypeError('terminated'))
    },
  })
}

async function statusFailure(answer: FakeResponse): Promise<unknown> {
  const { ctx } = contextWith([answer])
  const response = await sendGitHubRequest(ctx, PATH, ACCEPT_JSON)
  return failureOf(ensureOk(response, ctx))
}

describe('sendGitHubRequest', () => {
  it('sends a GET to the API with auth, accept, API version and user agent headers', async () => {
    const { ctx, calls } = contextWith([{ status: 200, body: '{}' }])

    const response = await sendGitHubRequest(ctx, PATH, ACCEPT_JSON)

    expect(response.status).toBe(200)
    expect(calls).toEqual([
      {
        url: 'https://api.github.com/repos/saulosw/phada/pulls/12',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'phada',
        },
      },
    ])
  })

  it('uses the accept header it is given', async () => {
    const fake = createFakeFetch({ [ACCEPT_DIFF]: [{ status: 200, body: 'diff' }] })

    await sendGitHubRequest(
      { token: TOKEN, fetch: fake.fetch, timeoutMs: 1_000 },
      PATH,
      ACCEPT_DIFF,
    )

    expect(fake.calls[0]?.headers['accept']).toBe('application/vnd.github.diff')
  })

  it.each(['', `${TOKEN}\n`, `${TOKEN}\r`, `${TOKEN}\nUsage: gh`, 'ghp_with space', '\tghp_x'])(
    'rejects the malformed token %j before calling fetch',
    async (token) => {
      const { ctx, calls } = contextWith([{ status: 200, body: '{}' }])

      const error = await failureOf(sendGitHubRequest({ ...ctx, token }, PATH, ACCEPT_JSON))

      expect(error).toBeInstanceOf(GitHubRequestError)
      expect((error as GitHubRequestError).message).toBe(
        'The GitHub token is malformed: it is empty or contains spaces or control characters.',
      )
      expect(calls).toHaveLength(0)
    },
  )

  it('returns non-2xx responses instead of throwing', async () => {
    const { ctx } = contextWith([{ status: 500, body: 'boom' }])

    const response = await sendGitHubRequest(ctx, PATH, ACCEPT_JSON)

    expect(response.status).toBe(500)
  })

  it('wraps a network failure in GitHubRequestError with the cause', async () => {
    const { ctx } = contextWith(['network-error'])

    const error = await failureOf(sendGitHubRequest(ctx, PATH, ACCEPT_JSON))

    expect(error).toBeInstanceOf(GitHubRequestError)
    expect((error as GitHubRequestError).message).toBe('Could not reach GitHub')
    expect((error as GitHubRequestError).cause).toEqual(new TypeError('fetch failed'))
  })

  it('turns a request that never answers into a timeout error', async () => {
    const { ctx } = contextWith(['hang'], 10)

    const error = await failureOf(sendGitHubRequest(ctx, PATH, ACCEPT_JSON))

    expect(error).toBeInstanceOf(GitHubRequestError)
    expect((error as GitHubRequestError).message).toBe('GitHub did not respond within 0.01s')
    expect((error as GitHubRequestError).status).toBeUndefined()
  }, 2_000)

  it.each([
    ['an abort that is not a timeout', new DOMException('aborted', 'AbortError')],
    ['a non-DOM error named TimeoutError', Object.assign(new Error('x'), { name: 'TimeoutError' })],
  ])('does not report %s as a timeout', async (_, failure) => {
    const fetch = async (): Promise<Response> => {
      throw failure
    }

    const error = await failureOf(
      sendGitHubRequest({ token: TOKEN, fetch, timeoutMs: 1_000 }, PATH, ACCEPT_JSON),
    )

    expect((error as GitHubRequestError).message).toBe('Could not reach GitHub')
    expect((error as GitHubRequestError).cause).toBe(failure)
  })
})

describe('ensureOk', () => {
  it('accepts a 2xx response', async () => {
    const { ctx } = contextWith([{ status: 200, body: '{}' }])
    const response = await sendGitHubRequest(ctx, PATH, ACCEPT_JSON)

    await expect(ensureOk(response, ctx)).resolves.toBeUndefined()
  })

  it('maps 401 to GitHubAuthError', async () => {
    const error = await statusFailure({ status: 401, body: '{"message":"Bad credentials"}' })

    expect(error).toBeInstanceOf(GitHubAuthError)
    expect((error as GitHubAuthError).status).toBe(401)
    expect((error as GitHubAuthError).apiMessage).toBe('Bad credentials')
    expect((error as GitHubAuthError).message).toBe(
      'GitHub rejected the token (HTTP 401): it is invalid or expired. GitHub says: Bad credentials',
    )
  })

  it('keeps the GitHub message on a 403, e.g. SAML enforcement on an organization', async () => {
    const saml =
      'Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.'
    const error = await statusFailure({ status: 403, body: JSON.stringify({ message: saml }) })

    expect(error).toBeInstanceOf(GitHubAuthError)
    expect((error as GitHubAuthError).apiMessage).toBe(saml)
    expect((error as GitHubAuthError).message).toBe(
      `GitHub denied access (HTTP 403). The token may lack access to this repository. GitHub says: ${saml}`,
    )
  })

  it('maps a 403 whose message mentions a rate limit to GitHubRateLimitError, even without headers', async () => {
    const error = await statusFailure({
      status: 403,
      body: JSON.stringify({
        message:
          'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
      }),
    })

    expect(error).toBeInstanceOf(GitHubRateLimitError)
  })

  it('maps a plain 403 to GitHubAuthError', async () => {
    const error = await statusFailure({
      status: 403,
      body: '{"message":"Resource not accessible"}',
      headers: { 'x-ratelimit-remaining': '4999' },
    })

    expect(error).toBeInstanceOf(GitHubAuthError)
    expect((error as GitHubAuthError).status).toBe(403)
  })

  it('maps a 403 with no remaining quota to GitHubRateLimitError with the reset time', async () => {
    const error = await statusFailure({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' },
    })

    expect(error).toBeInstanceOf(GitHubRateLimitError)
    expect((error as GitHubRateLimitError).resetAt).toEqual(new Date(1_790_000_000_000))
    expect((error as GitHubRateLimitError).retryAfterSeconds).toBeUndefined()
    expect((error as GitHubRateLimitError).message).toBe(
      'GitHub rate limit exceeded (resets at 2026-09-21T14:13:20.000Z).',
    )
  })

  it('maps a 403 with retry-after (secondary rate limit) to GitHubRateLimitError', async () => {
    const error = await statusFailure({ status: 403, headers: { 'retry-after': '60' } })

    expect(error).toBeInstanceOf(GitHubRateLimitError)
    expect((error as GitHubRateLimitError).retryAfterSeconds).toBe(60)
    expect((error as GitHubRateLimitError).resetAt).toBeUndefined()
  })

  it('maps 429 to GitHubRateLimitError even without headers', async () => {
    const error = await statusFailure({ status: 429 })

    expect(error).toBeInstanceOf(GitHubRateLimitError)
    expect((error as GitHubRateLimitError).message).toBe('GitHub rate limit exceeded.')
  })

  it('maps other statuses to GitHubRequestError with at most 200 characters of the body', async () => {
    const error = await statusFailure({ status: 500, body: 'x'.repeat(5_000) })

    expect(error).toBeInstanceOf(GitHubRequestError)
    expect((error as GitHubRequestError).status).toBe(500)
    expect((error as GitHubRequestError).message).toBe(
      `GitHub responded with HTTP 500: ${'x'.repeat(200)}`,
    )
  })

  it('maps a 5xx with retry-after to GitHubRequestError, not to a rate limit', async () => {
    const error = await statusFailure({ status: 503, headers: { 'retry-after': '30' } })

    expect(error).toBeInstanceOf(GitHubRequestError)
    expect((error as GitHubRequestError).status).toBe(503)
  })

  it('ignores empty rate limit headers', async () => {
    const error = await statusFailure({
      status: 429,
      headers: { 'x-ratelimit-reset': '', 'retry-after': '' },
    })

    expect(error).toBeInstanceOf(GitHubRateLimitError)
    expect((error as GitHubRateLimitError).resetAt).toBeUndefined()
    expect((error as GitHubRateLimitError).retryAfterSeconds).toBeUndefined()
  })

  it('still reports the status when the error body cannot be read', async () => {
    const { ctx } = contextWith([])
    const response = new Response(brokenBody(), { status: 500 })

    const error = await failureOf(ensureOk(response, ctx))

    expect((error as GitHubRequestError).message).toBe('GitHub responded with HTTP 500')
    expect((error as GitHubRequestError).status).toBe(500)
  })

  it('omits the body snippet when the body is empty', async () => {
    const error = await statusFailure({ status: 502 })

    expect((error as GitHubRequestError).message).toBe('GitHub responded with HTTP 502')
  })

  it('never leaks a prefix of the token cut at the snippet boundary', async () => {
    const error = await statusFailure({ status: 500, body: `${'x'.repeat(195)}${TOKEN}` })

    expect((error as GitHubRequestError).message).toBe(
      `GitHub responded with HTTP 500: ${'x'.repeat(195)}[REDA`,
    )
  })
})

describe('readJson and readText', () => {
  it('reads the body as text and as JSON', async () => {
    const { ctx } = contextWith([
      { status: 200, body: 'plain' },
      { status: 200, body: '{"a":1}' },
    ])

    expect(await readText(await sendGitHubRequest(ctx, PATH, ACCEPT_JSON), ctx)).toBe('plain')
    expect(await readJson(await sendGitHubRequest(ctx, PATH, ACCEPT_JSON), ctx)).toEqual({ a: 1 })
  })

  it('wraps a body that fails mid-read in GitHubRequestError', async () => {
    const { ctx } = contextWith([])

    const error = await failureOf(readText(new Response(brokenBody()), ctx))

    expect(error).toBeInstanceOf(GitHubRequestError)
    expect((error as GitHubRequestError).message).toBe('Could not reach GitHub')
    expect((error as GitHubRequestError).cause).toEqual(new TypeError('terminated'))
  })

  it('rejects invalid JSON with GitHubRequestError', async () => {
    const { ctx } = contextWith([{ status: 200, body: '<html>' }])
    const response = await sendGitHubRequest(ctx, PATH, ACCEPT_JSON)

    const error = await failureOf(readJson(response, ctx))

    expect(error).toBeInstanceOf(GitHubRequestError)
    expect((error as GitHubRequestError).message).toBe('GitHub returned invalid JSON')
  })
})

describe('redact and toErrorSnippet', () => {
  it('replaces every occurrence of the token', () => {
    expect(redact(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe('a [REDACTED] b [REDACTED]')
  })

  it('leaves the text untouched when the token is empty', () => {
    expect(redact('abc', '')).toBe('abc')
  })

  it('redacts before truncating to 200 characters', () => {
    expect(toErrorSnippet(`${'y'.repeat(198)}${TOKEN}`, TOKEN)).toBe(`${'y'.repeat(198)}[R`)
  })
})
