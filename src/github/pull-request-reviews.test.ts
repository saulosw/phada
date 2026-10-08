import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import type { FakeCall, FakeResponse } from '../../test/support/fake-fetch.js'
import { GitHubRequestError, PullRequestNotFoundError } from './errors.js'
import { fetchReviewState } from './pull-request-reviews.js'

const TOKEN = 'ghp_SECRET_test_token'
const HEAD_SHA = 'f41a2c3280de0d54ab06d79fa18e93e576e511e6'
const REVIEW_ID = 'PRR_kwDOQNCyRM8AAAABRNso_Q'

type Json = Record<string, unknown>
const fixture = (name: string): Json =>
  JSON.parse(
    readFileSync(new URL(`../../test/fixtures/github/${name}`, import.meta.url), 'utf8'),
  ) as Json
const ok = (body: unknown): FakeResponse => ({ status: 200, body: JSON.stringify(body) })

const byQuery = (call: FakeCall) =>
  (JSON.parse(call.body ?? '{}') as { query: string }).query.includes('reviewThreads')
    ? 'threads'
    : 'reviews'

function fakeGitHub(reviews: FakeResponse[], threads: FakeResponse[] = []) {
  return createFakeFetch({ reviews, threads }, byQuery)
}

function fetchWith(fetch: typeof globalThis.fetch, number = 11) {
  return fetchReviewState({ owner: 'saulosw', repo: 'phada-dev-web', number, token: TOKEN, fetch })
}

function variablesOf(call: FakeCall | undefined): Json {
  return (JSON.parse(call?.body ?? '{}') as { variables: Json }).variables
}

function connection(page: Json, name: string): Json {
  const pullRequest = (page.data as Json).repository as Json
  return (pullRequest.pullRequest as Json)[name] as Json
}

function withPage(page: Json, name: string, change: (root: Json) => void): Json {
  const copy = structuredClone(page)
  change(connection(copy, name))
  return copy
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

describe('fetchReviewState', () => {
  it('reads the viewer, reviews and threads from the captured responses', async () => {
    const { fetch } = fakeGitHub(
      [ok(fixture('graphql-reviews.json'))],
      [ok(fixture('graphql-threads.json'))],
    )

    const state = await fetchWith(fetch)

    expect(state).toEqual({
      viewer: 'saulosw',
      reviews: [
        {
          id: REVIEW_ID,
          author: 'saulosw',
          body: `Captured review.\n\n<!-- phada:review sha=${HEAD_SHA} findings=1 -->`,
          commitSha: HEAD_SHA,
        },
      ],
      threads: [
        {
          isResolved: false,
          path: 'api/src/routes/users.ts',
          line: 63,
          author: 'saulosw',
          body: "**P0** · Any user can spend another user's crystals · confidence 95\n\nThe user id comes from the request body.\n\n<!-- phada:finding -->",
          reviewId: REVIEW_ID,
        },
      ],
    })
  })

  it('sends the owner, repo and number as variables', async () => {
    const { fetch, calls } = fakeGitHub(
      [ok(fixture('graphql-reviews.json'))],
      [ok(fixture('graphql-threads.json'))],
    )

    await fetchWith(fetch)

    expect(calls.map(variablesOf)).toEqual([
      { owner: 'saulosw', repo: 'phada-dev-web', number: 11, after: null },
      { owner: 'saulosw', repo: 'phada-dev-web', number: 11, after: null },
    ])
  })

  it('follows the cursors of both connections', async () => {
    const reviews = fixture('graphql-reviews.json')
    const threads = fixture('graphql-threads.json')
    const firstReviews = withPage(reviews, 'reviews', (root) => {
      root.pageInfo = { hasNextPage: true, endCursor: 'R1' }
    })
    const secondReviews = withPage(reviews, 'reviews', (root) => {
      ;(root.nodes as Json[])[0]!.id = 'PRR_second'
    })
    const firstThreads = withPage(threads, 'reviewThreads', (root) => {
      root.pageInfo = { hasNextPage: true, endCursor: 'T1' }
    })
    const { fetch, calls } = fakeGitHub(
      [ok(firstReviews), ok(secondReviews)],
      [ok(firstThreads), ok(threads)],
    )

    const state = await fetchWith(fetch)

    expect(state.reviews.map(({ id }) => id)).toEqual([REVIEW_ID, 'PRR_second'])
    expect(state.threads).toHaveLength(2)
    expect(calls.map((call) => variablesOf(call).after)).toEqual([null, 'R1', null, 'T1'])
  })

  it('reads a deleted author as an empty login', async () => {
    const reviews = withPage(fixture('graphql-reviews.json'), 'reviews', (root) => {
      ;(root.nodes as Json[])[0]!.author = null
    })
    const threads = withPage(fixture('graphql-threads.json'), 'reviewThreads', (root) => {
      const comments = (root.nodes as Json[])[0]!.comments as Json
      ;(comments.nodes as Json[])[0]!.author = null
    })
    const { fetch } = fakeGitHub([ok(reviews)], [ok(threads)])

    const state = await fetchWith(fetch)

    expect(state.reviews[0]?.author).toBe('')
    expect(state.threads[0]?.author).toBe('')
  })

  it('reads a thread without comments as one without author, body or review', async () => {
    const threads = withPage(fixture('graphql-threads.json'), 'reviewThreads', (root) => {
      ;(root.nodes as Json[])[0]!.comments = { nodes: [] }
    })
    const { fetch } = fakeGitHub([ok(fixture('graphql-reviews.json'))], [ok(threads)])

    const [thread] = (await fetchWith(fetch)).threads

    expect(thread).toMatchObject({ author: '', body: '', reviewId: null })
  })

  it('reads an outdated thread line and a review without commit as null', async () => {
    const reviews = withPage(fixture('graphql-reviews.json'), 'reviews', (root) => {
      ;(root.nodes as Json[])[0]!.commit = null
    })
    const threads = withPage(fixture('graphql-threads.json'), 'reviewThreads', (root) => {
      ;(root.nodes as Json[])[0]!.line = null
    })
    const { fetch } = fakeGitHub([ok(reviews)], [ok(threads)])

    const state = await fetchWith(fetch)

    expect(state.reviews[0]?.commitSha).toBeNull()
    expect(state.threads[0]?.line).toBeNull()
  })

  it('throws PullRequestNotFoundError for NOT_FOUND', async () => {
    const { fetch } = fakeGitHub([ok(fixture('graphql-not-found.json'))])

    const error = await failureOf(fetchWith(fetch, 99999))

    expect(error).toBeInstanceOf(PullRequestNotFoundError)
    expect(error).toMatchObject({ ref: 'saulosw/phada-dev-web#99999' })
  })

  it('throws PullRequestNotFoundError when the pull request is null without errors', async () => {
    const { fetch } = fakeGitHub([
      ok({ data: { viewer: { login: 'saulosw' }, repository: { pullRequest: null } } }),
    ])

    expect(await failureOf(fetchWith(fetch))).toBeInstanceOf(PullRequestNotFoundError)
  })

  it('rejects a page that says there is more without a cursor', async () => {
    const reviews = withPage(fixture('graphql-reviews.json'), 'reviews', (root) => {
      root.pageInfo = { hasNextPage: true, endCursor: null }
    })
    const { fetch } = fakeGitHub([ok(reviews)])

    const error = await failureOf(fetchWith(fetch))

    expect(error).toBeInstanceOf(GitHubRequestError)
    expect((error as Error).message).toBe(
      'Unexpected GitHub response: missing or invalid "reviews.pageInfo.endCursor"',
    )
  })

  it('rejects a thread with an invalid line', async () => {
    const threads = withPage(fixture('graphql-threads.json'), 'reviewThreads', (root) => {
      ;(root.nodes as Json[])[0]!.line = '63'
    })
    const { fetch } = fakeGitHub([ok(fixture('graphql-reviews.json'))], [ok(threads)])

    const error = await failureOf(fetchWith(fetch))

    expect((error as Error).message).toBe('Unexpected GitHub response: missing or invalid "line"')
  })
})
