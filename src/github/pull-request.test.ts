import { readFileSync } from 'node:fs'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import type { FakeResponse } from '../../test/support/fake-fetch.js'
import {
  DiffTooLargeError,
  GitHubAuthError,
  GitHubRateLimitError,
  GitHubRequestError,
  PullRequestNotFoundError,
} from './errors.js'
import { fetchPullRequest } from './pull-request.js'
import type { FetchPullRequestOptions } from './pull-request.js'
import { ACCEPT_DIFF, ACCEPT_JSON } from './request.js'

const TOKEN = 'ghp_SECRET_test_token'
const API_URL = 'https://api.github.com/repos/saulosw/phada-dev-web/pulls/3'

const fixture = (name: string) =>
  readFileSync(new URL(`../../test/fixtures/github/${name}`, import.meta.url), 'utf8')
const METADATA_JSON = fixture('pull-request.json')
const DIFF = fixture('pull-request.diff')
const DIFF_TOO_LARGE_JSON = fixture('diff-too-large.json')

type Json = Record<string, unknown>
const metadata = (): Json => JSON.parse(METADATA_JSON) as Json
const ok = (body: string): FakeResponse => ({ status: 200, body })

function fakeGitHub(meta: FakeResponse[], diff: FakeResponse[] = []) {
  return createFakeFetch({ [ACCEPT_JSON]: meta, [ACCEPT_DIFF]: diff })
}

function fetchWith(
  fetch: typeof globalThis.fetch,
  overrides: Partial<FetchPullRequestOptions> = {},
) {
  return fetchPullRequest({
    owner: 'saulosw',
    repo: 'phada-dev-web',
    number: 3,
    token: TOKEN,
    fetch,
    ...overrides,
  })
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

describe('fetchPullRequest', () => {
  it('returns the enriched pull request built from the real API response', async () => {
    const github = fakeGitHub([ok(METADATA_JSON)], [ok(DIFF)])

    const pr = await fetchWith(github.fetch)

    expect(pr).toEqual({
      repo: 'saulosw/phada-dev-web',
      number: 3,
      url: 'https://github.com/saulosw/phada-dev-web/pull/3',
      title: 'feat: let users spend crystals in the shop',
      description: 'Fixture for Phada tests: a trimmed real response from the GitHub REST API.',
      author: 'saulosw',
      state: 'open',
      draft: false,
      baseRef: 'develop',
      baseSha: 'c0d92ffe6bcf7cbe3200b67190cf1324162a66be',
      headRef: 'feat/spend-crystals',
      headSha: 'f41a2c3280de0d54ab06d79fa18e93e576e511e6',
      fromFork: false,
      private: true,
      stats: { changedFiles: 2, additions: 15, deletions: 1, commits: 1 },
      diff: DIFF,
    })
  })

  it('reads whether the repository is public', async () => {
    const json = metadata()
    const base = json['base'] as Json
    const repo = { ...(base['repo'] as Json), private: false }
    const github = fakeGitHub(
      [ok(JSON.stringify({ ...json, base: { ...base, repo } }))],
      [ok(DIFF)],
    )

    expect((await fetchWith(github.fetch)).private).toBe(false)
  })

  it('asks for the metadata first and the diff second, on the same endpoint', async () => {
    const github = fakeGitHub([ok(METADATA_JSON)], [ok(DIFF)])

    await fetchWith(github.fetch)

    expect(github.calls.map((call) => [call.url, call.headers['accept']])).toEqual([
      [API_URL, 'application/vnd.github+json'],
      [API_URL, 'application/vnd.github.diff'],
    ])
  })

  it('accepts a closed pull request and an empty diff', async () => {
    const closed = { ...metadata(), state: 'closed', merged: true }
    const github = fakeGitHub([ok(JSON.stringify(closed))], [ok('')])

    const pr = await fetchWith(github.fetch)

    expect(pr.state).toBe('closed')
    expect(pr.diff).toBe('')
  })

  it('maps a null body to an empty description', async () => {
    const github = fakeGitHub([ok(JSON.stringify({ ...metadata(), body: null }))], [ok(DIFF)])

    const pr = await fetchWith(github.fetch)

    expect(pr.description).toBe('')
  })

  it.each([
    ['a different repository', { full_name: 'someone/phada-dev-web' }, true],
    ['a deleted fork', null, true],
    ['the same repository', { full_name: 'saulosw/phada-dev-web' }, false],
  ])('sets fromFork when the head comes from %s', async (_, headRepo, expected) => {
    const json = metadata()
    const head = { ...(json['head'] as Json), repo: headRepo }
    const github = fakeGitHub([ok(JSON.stringify({ ...json, head }))], [ok(DIFF)])

    const pr = await fetchWith(github.fetch)

    expect(pr.fromFork).toBe(expected)
  })

  it('throws PullRequestNotFoundError on 404 without asking for the diff', async () => {
    const github = fakeGitHub([{ status: 404, body: '{"message":"Not Found"}' }], [ok(DIFF)])

    const error = await failureOf(fetchWith(github.fetch))

    expect(error).toBeInstanceOf(PullRequestNotFoundError)
    expect((error as PullRequestNotFoundError).ref).toBe('saulosw/phada-dev-web#3')
    expect(github.calls).toHaveLength(1)
  })

  it('maps auth failures on the metadata request', async () => {
    const github = fakeGitHub([{ status: 401, body: '{"message":"Bad credentials"}' }])

    const error = await failureOf(fetchWith(github.fetch))

    expect(error).toBeInstanceOf(GitHubAuthError)
    expect((error as GitHubAuthError).status).toBe(401)
  })

  it.each([
    [
      'head.sha',
      (json: Json) => ({ ...json, head: { ...(json['head'] as Json), sha: undefined } }),
    ],
    ['title', (json: Json) => ({ ...json, title: 42 })],
    ['state', (json: Json) => ({ ...json, state: 'merged' })],
    ['body', (json: Json) => ({ ...json, body: 7 })],
    ['changed_files', (json: Json) => ({ ...json, changed_files: '2' })],
    ['draft', (json: Json) => ({ ...json, draft: 'false' })],
    ['base.repo.full_name', () => null],
  ])('rejects a payload with a missing or invalid %s', async (path, mutate) => {
    const github = fakeGitHub([ok(JSON.stringify(mutate(metadata())))], [ok(DIFF)])

    const error = await failureOf(fetchWith(github.fetch))

    expect(error).toBeInstanceOf(GitHubRequestError)
    expect((error as GitHubRequestError).message).toBe(
      `Unexpected GitHub response: missing or invalid "${path}"`,
    )
    expect(github.calls).toHaveLength(1)
  })

  it('throws DiffTooLargeError with the API message when GitHub refuses the diff (406)', async () => {
    const tooMany = { ...metadata(), changed_files: 659 }
    const github = fakeGitHub(
      [ok(JSON.stringify(tooMany))],
      [{ status: 406, body: DIFF_TOO_LARGE_JSON }],
    )

    const error = await failureOf(fetchWith(github.fetch))

    expect(error).toBeInstanceOf(DiffTooLargeError)
    expect(error).toMatchObject({
      ref: 'saulosw/phada-dev-web#3',
      changedFiles: 659,
      bytes: undefined,
      maxBytes: undefined,
      apiMessage:
        "Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead.",
    })
    expect((error as DiffTooLargeError).message).toBe(
      'GitHub refused to return the diff of saulosw/phada-dev-web#3 (659 changed files). ' +
        "GitHub says: Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead.",
    )
  })

  it('treats 422 on the diff request as a diff that is too large', async () => {
    const github = fakeGitHub([ok(METADATA_JSON)], [{ status: 422, body: '{"message":"too big"}' }])

    const error = await failureOf(fetchWith(github.fetch))

    expect(error).toBeInstanceOf(DiffTooLargeError)
    expect((error as DiffTooLargeError).apiMessage).toBe('too big')
  })

  it('still throws DiffTooLargeError when the refusal body is not JSON', async () => {
    const github = fakeGitHub([ok(METADATA_JSON)], [{ status: 406, body: '<html>nope</html>' }])

    const error = await failureOf(fetchWith(github.fetch))

    expect(error).toBeInstanceOf(DiffTooLargeError)
    expect((error as DiffTooLargeError).apiMessage).toBeUndefined()
    expect((error as DiffTooLargeError).message).toBe(
      'GitHub refused to return the diff of saulosw/phada-dev-web#3 (2 changed files).',
    )
  })

  it('accepts a diff of exactly maxDiffBytes', async () => {
    const github = fakeGitHub([ok(METADATA_JSON)], [ok('a'.repeat(10))])

    const pr = await fetchWith(github.fetch, { maxDiffBytes: 10 })

    expect(pr.diff).toBe('a'.repeat(10))
  })

  it('rejects a diff one byte above maxDiffBytes, without truncating it', async () => {
    const github = fakeGitHub([ok(METADATA_JSON)], [ok('a'.repeat(11))])

    const error = await failureOf(fetchWith(github.fetch, { maxDiffBytes: 10 }))

    expect(error).toBeInstanceOf(DiffTooLargeError)
    expect(error).toMatchObject({ bytes: 11, maxBytes: 10, changedFiles: 2 })
    expect((error as DiffTooLargeError).message).toBe(
      'The diff of saulosw/phada-dev-web#3 has 11 bytes (2 changed files), above the limit of 10 bytes.',
    )
  })

  it('measures the diff in UTF-8 bytes, not characters', async () => {
    // 6 characters, 12 bytes.
    const github = fakeGitHub([ok(METADATA_JSON)], [ok('é'.repeat(6))])

    const error = await failureOf(fetchWith(github.fetch, { maxDiffBytes: 10 }))

    expect(error).toBeInstanceOf(DiffTooLargeError)
    expect((error as DiffTooLargeError).bytes).toBe(12)
  })

  it('maps other failures on the diff request through the generic mapping', async () => {
    const github = fakeGitHub([ok(METADATA_JSON)], [{ status: 500, body: 'oops' }])

    const error = await failureOf(fetchWith(github.fetch))

    expect(error).toBeInstanceOf(GitHubRequestError)
    expect((error as GitHubRequestError).message).toBe('GitHub responded with HTTP 500: oops')
  })
})

describe('fetchPullRequest never leaks the token', () => {
  // The fake server echoes the token twice in every body it can.
  const echo = `token ${TOKEN} and again ${TOKEN}`
  // What `$(gh auth token)` captures on gh versions without that command: a line break inside
  // the value, which makes fetch reject the header with a message that quotes it.
  const usageText = `${TOKEN}\nUsage:  gh auth <command> [flags]`

  type ErrorClass = new (...args: never[]) => Error
  it.each<[string, FakeResponse[], FakeResponse[], Partial<FetchPullRequestOptions>, ErrorClass]>([
    ['401', [{ status: 401, body: echo }], [], {}, GitHubAuthError],
    ['403', [{ status: 403, body: echo }], [], {}, GitHubAuthError],
    [
      '403 with a JSON message',
      [{ status: 403, body: JSON.stringify({ message: echo }) }],
      [],
      {},
      GitHubAuthError,
    ],
    [
      '403 rate limit',
      [{ status: 403, body: echo, headers: { 'retry-after': '1' } }],
      [],
      {},
      GitHubRateLimitError,
    ],
    ['429', [{ status: 429, body: echo }], [], {}, GitHubRateLimitError],
    ['404', [{ status: 404, body: echo }], [], {}, PullRequestNotFoundError],
    ['500 on metadata', [{ status: 500, body: echo }], [], {}, GitHubRequestError],
    ['invalid JSON', [ok(echo)], [], {}, GitHubRequestError],
    ['invalid payload', [ok(JSON.stringify({ title: echo }))], [], {}, GitHubRequestError],
    [
      '406 on diff',
      [ok(METADATA_JSON)],
      [{ status: 406, body: JSON.stringify({ message: echo }) }],
      {},
      DiffTooLargeError,
    ],
    ['500 on diff', [ok(METADATA_JSON)], [{ status: 500, body: echo }], {}, GitHubRequestError],
    [
      'diff over the limit',
      [ok(METADATA_JSON)],
      [ok(echo)],
      { maxDiffBytes: 1 },
      DiffTooLargeError,
    ],
    ['network error', ['network-error'], [], {}, GitHubRequestError],
    ['timeout', ['hang'], [], { timeoutMs: 10 }, GitHubRequestError],
    [
      'malformed token (gh usage text)',
      [ok(METADATA_JSON)],
      [ok(DIFF)],
      { token: usageText },
      GitHubRequestError,
    ],
  ])('%s', async (_, meta, diff, overrides, expectedClass) => {
    const github = fakeGitHub(meta, diff)

    const error = await failureOf(fetchWith(github.fetch, overrides))

    expect(error).toBeInstanceOf(expectedClass)
    expect((error as Error).message).not.toContain(TOKEN)
    expect(JSON.stringify(error)).not.toContain(TOKEN)
    expect(inspect(error, { depth: 5 })).not.toContain(TOKEN)
  })
})
