import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import type { FakeResponse } from '../../test/support/fake-fetch.js'
import { createReview } from './create-review.js'
import type { CreateReviewOptions } from './create-review.js'
import {
  GitHubAuthError,
  GitHubRateLimitError,
  GitHubRequestError,
  ReviewPermissionError,
  ReviewRejectedError,
  ReviewRepositoryAccessError,
} from './errors.js'
import { ACCEPT_JSON } from './request.js'

const TOKEN = 'ghp_SECRET_test_token'
const HEAD_SHA = 'f41a2c3280de0d54ab06d79fa18e93e576e511e6'
const REF = 'saulosw/phada-dev-web#3'

const fixture = (name: string) =>
  readFileSync(new URL(`../../test/fixtures/github/${name}`, import.meta.url), 'utf8')

function publish(answers: FakeResponse[], overrides: Partial<CreateReviewOptions> = {}) {
  const fake = createFakeFetch({ [ACCEPT_JSON]: answers })
  const result = createReview({
    owner: 'saulosw',
    repo: 'phada-dev-web',
    number: 3,
    token: TOKEN,
    commitSha: HEAD_SHA,
    body: 'Review body',
    comments: [
      { path: 'api/src/routes/users.ts', line: 63, body: 'First' },
      { path: 'src/hooks/useCooldown.ts', line: 18, body: 'Second' },
    ],
    fetch: fake.fetch,
    ...overrides,
  })
  return { result, calls: fake.calls }
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

describe('createReview', () => {
  it('posts one COMMENT review on the commit with every comment on the RIGHT side', async () => {
    const { result, calls } = publish([{ status: 200, body: fixture('create-review.json') }])

    expect(await result).toEqual({
      url: 'https://github.com/saulosw/phada-dev-web/pull/11#pullrequestreview-5450180861',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.github.com/repos/saulosw/phada-dev-web/pulls/3/reviews')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.headers['content-type']).toBe('application/json')
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
      commit_id: HEAD_SHA,
      event: 'COMMENT',
      body: 'Review body',
      comments: [
        { path: 'api/src/routes/users.ts', line: 63, side: 'RIGHT', body: 'First' },
        { path: 'src/hooks/useCooldown.ts', line: 18, side: 'RIGHT', body: 'Second' },
      ],
    })
  })

  it('posts a review without comments', async () => {
    const { result, calls } = publish([{ status: 200, body: fixture('create-review.json') }], {
      comments: [],
    })

    await result

    expect(JSON.parse(calls[0]?.body ?? '')).toMatchObject({ comments: [] })
  })

  it('maps 403 to ReviewPermissionError with the GitHub message', async () => {
    const body = '{"message":"Resource not accessible by personal access token"}'
    const { result } = publish([{ status: 403, body }])

    const error = await failureOf(result)

    expect(error).toBeInstanceOf(ReviewPermissionError)
    expect((error as Error).message).toBe(
      `GitHub denied publishing the review on ${REF} (HTTP 403): the token cannot write pull request reviews. ` +
        'Use a fine-grained token with "Pull requests: Read and write" or a classic token with the repo scope ' +
        '(public_repo for public repositories), or run with --dry-run to only print the review. ' +
        'GitHub says: Resource not accessible by personal access token',
    )
  })

  it('keeps a rate-limited 403 as GitHubRateLimitError', async () => {
    const { result } = publish([
      {
        status: 403,
        body: '{"message":"API rate limit exceeded"}',
        headers: { 'x-ratelimit-remaining': '0' },
      },
    ])

    expect(await failureOf(result)).toBeInstanceOf(GitHubRateLimitError)
  })

  it('maps 404 to ReviewRepositoryAccessError', async () => {
    const { result } = publish([{ status: 404, body: '{"message":"Not Found"}' }])

    const error = await failureOf(result)

    expect(error).toBeInstanceOf(ReviewRepositoryAccessError)
    expect((error as Error).message).toBe(
      `GitHub answered 404 when publishing the review on ${REF}: the token cannot write to this repository. A fine-grained token must include the repository.`,
    )
  })

  it('maps 422 to ReviewRejectedError with the message and errors of GitHub', async () => {
    const { result } = publish([{ status: 422, body: fixture('create-review-422.json') }])

    const error = await failureOf(result)

    expect(error).toBeInstanceOf(ReviewRejectedError)
    expect((error as Error).message).toBe(
      `GitHub rejected the review on ${REF} (HTTP 422): Unprocessable Entity; Line could not be resolved`,
    )
  })

  it('reads errors given as objects and redacts the token in a 422', async () => {
    const body = JSON.stringify({
      message: 'Validation Failed',
      errors: [{ message: `bad ${TOKEN}` }, { code: 'invalid' }],
    })
    const { result } = publish([{ status: 422, body }])

    expect((await failureOf(result)) as Error).toMatchObject({
      details: 'Validation Failed; bad [REDACTED]',
    })
  })

  it('maps a 422 without a JSON body to a plain rejection', async () => {
    const { result } = publish([{ status: 422, body: 'nope' }])

    expect(((await failureOf(result)) as Error).message).toBe(
      `GitHub rejected the review on ${REF} (HTTP 422).`,
    )
  })

  it('maps 401 to GitHubAuthError', async () => {
    const { result } = publish([{ status: 401, body: '{"message":"Bad credentials"}' }])

    expect(await failureOf(result)).toBeInstanceOf(GitHubAuthError)
  })

  it('rejects a success without html_url', async () => {
    const { result } = publish([{ status: 200, body: '{"id":1}' }])

    expect(await failureOf(result)).toBeInstanceOf(GitHubRequestError)
  })
})
