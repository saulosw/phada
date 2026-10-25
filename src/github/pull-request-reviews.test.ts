import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import type { FakeCall, FakeResponse } from '../../test/support/fake-fetch.js'
import { GitHubRequestError, PullRequestNotFoundError } from './errors.js'
import { fetchPullComments, fetchReviewState } from './pull-request-reviews.js'

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
      pullState: 'open',
      reviews: [
        {
          id: REVIEW_ID,
          author: 'saulosw',
          body: `Captured review.\n\n<!-- phada:review sha=${HEAD_SHA} findings=1 -->`,
          commitSha: HEAD_SHA,
          url: 'https://github.com/saulosw/phada-dev-web/pull/11#pullrequestreview-5444118781',
          state: 'commented',
          createdAt: '2026-10-08T00:58:40Z',
          association: 'OWNER',
          bot: false,
        },
      ],
      threads: [
        {
          id: 'PRRT_kwDOQNCyRM5c8pXa',
          isResolved: false,
          isOutdated: false,
          path: 'api/src/routes/users.ts',
          line: 63,
          url: 'https://github.com/saulosw/phada-dev-web/pull/11#discussion_r2410000001',
          author: 'saulosw',
          body: "**P0** · Any user can spend another user's crystals · confidence 95\n\nThe user id comes from the request body.\n\n<!-- phada:finding -->",
          reviewId: REVIEW_ID,
          negativeReactions: 0,
          commentId: 'PRRC_kwDOQNCyRM6PqA01',
          createdAt: '2026-10-08T00:58:40Z',
          association: 'OWNER',
          bot: false,
          comments: 2,
          replies: [
            {
              id: 'PRRC_kwDOQNCyRM6PqA01',
              author: 'saulosw',
              body: "**P0** · Any user can spend another user's crystals · confidence 95\n\nThe user id comes from the request body.\n\n<!-- phada:finding -->",
              bot: false,
              createdAt: '2026-10-08T00:58:40Z',
              association: 'OWNER',
            },
            {
              id: 'PRRC_kwDOQNCyRM6PqB77',
              author: 'octocat',
              body: 'Still happens on main.',
              bot: false,
              createdAt: '2026-10-08T09:12:03Z',
              association: 'NONE',
            },
          ],
        },
      ],
    })
  })

  it.each([
    ['MERGED', 'merged'],
    ['CLOSED', 'closed'],
  ])('reads a %s pull request state', async (state, expected) => {
    const reviews = fixture('graphql-reviews.json')
    ;((reviews.data as Json).repository as Json).pullRequest = {
      ...(((reviews.data as Json).repository as Json).pullRequest as Json),
      state,
    }
    const { fetch } = fakeGitHub([ok(reviews)], [ok(fixture('graphql-threads.json'))])

    expect((await fetchWith(fetch)).pullState).toBe(expected)
  })

  it('counts thumbs down and confused reactions and reads outdated threads', async () => {
    const threads = withPage(fixture('graphql-threads.json'), 'reviewThreads', (root) => {
      const [thread] = root.nodes as Json[]
      thread!.isOutdated = true
      const [comment] = (thread!.comments as Json).nodes as Json[]
      comment!.reactionGroups = [
        { content: 'THUMBS_DOWN', reactors: { totalCount: 2 } },
        { content: 'CONFUSED', reactors: { totalCount: 1 } },
        { content: 'HEART', reactors: { totalCount: 3 } },
      ]
    })
    const { fetch } = fakeGitHub([ok(fixture('graphql-reviews.json'))], [ok(threads)])

    const [thread] = (await fetchWith(fetch)).threads

    expect(thread).toMatchObject({ isOutdated: true, negativeReactions: 3 })
  })

  it('reads a null reaction list as no reactions', async () => {
    const threads = withPage(fixture('graphql-threads.json'), 'reviewThreads', (root) => {
      const [thread] = root.nodes as Json[]
      const [comment] = (thread!.comments as Json).nodes as Json[]
      comment!.reactionGroups = null
    })
    const { fetch } = fakeGitHub([ok(fixture('graphql-reviews.json'))], [ok(threads)])

    const [thread] = (await fetchWith(fetch)).threads

    expect(thread?.negativeReactions).toBe(0)
  })

  it('marks replies written by bots and treats a deleted author as a person', async () => {
    const threads = withPage(fixture('graphql-threads.json'), 'reviewThreads', (root) => {
      const [thread] = root.nodes as Json[]
      ;(thread!.replies as Json).nodes = [
        {
          id: 'C1',
          body: 'Deployed.',
          createdAt: '2026-10-08T01:00:00Z',
          authorAssociation: 'NONE',
          author: { login: 'ci-bot', __typename: 'Bot' },
        },
        {
          id: 'C2',
          body: 'Gone.',
          createdAt: '2026-10-08T02:00:00Z',
          authorAssociation: 'NONE',
          author: null,
        },
      ]
    })
    const { fetch } = fakeGitHub([ok(fixture('graphql-reviews.json'))], [ok(threads)])

    const [thread] = (await fetchWith(fetch)).threads

    expect(thread?.replies).toEqual([
      {
        id: 'C1',
        author: 'ci-bot',
        body: 'Deployed.',
        bot: true,
        createdAt: '2026-10-08T01:00:00Z',
        association: 'NONE',
      },
      {
        id: 'C2',
        author: '',
        body: 'Gone.',
        bot: false,
        createdAt: '2026-10-08T02:00:00Z',
        association: 'NONE',
      },
    ])
  })

  it.each([
    ['APPROVED', 'approved'],
    ['CHANGES_REQUESTED', 'changes-requested'],
    ['DISMISSED', 'dismissed'],
    ['PENDING', 'pending'],
  ])('reads a %s review and a review written by a bot', async (state, expected) => {
    const reviews = withPage(fixture('graphql-reviews.json'), 'reviews', (root) => {
      const [review] = root.nodes as Json[]
      review!.state = state
      review!.author = { login: 'lint-app', __typename: 'Bot' }
    })
    const { fetch } = fakeGitHub([ok(reviews)], [ok(fixture('graphql-threads.json'))])

    const [review] = (await fetchWith(fetch)).reviews

    expect(review).toMatchObject({ state: expected, author: 'lint-app', bot: true })
  })

  it('rejects a review with an unknown state', async () => {
    const reviews = withPage(fixture('graphql-reviews.json'), 'reviews', (root) => {
      ;(root.nodes as Json[])[0]!.state = 'LGTM'
    })
    const { fetch } = fakeGitHub([ok(reviews)], [ok(fixture('graphql-threads.json'))])

    expect(((await failureOf(fetchWith(fetch))) as Error).message).toBe(
      'Unexpected GitHub response: missing or invalid "review.state"',
    )
  })

  it('asks for the thread id, its first comment and its last 20 replies', async () => {
    const { fetch, calls } = fakeGitHub(
      [ok(fixture('graphql-reviews.json'))],
      [ok(fixture('graphql-threads.json'))],
    )

    await fetchWith(fetch)

    const query = String(JSON.parse(calls[1]?.body ?? '{}').query)
    expect(query).toContain('id\n')
    expect(query).toContain('comments(first: 1)')
    expect(query).toContain('replies: comments(last: 20) {\n            totalCount')
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
      ;(root.nodes as Json[])[0]!.replies = { totalCount: 0, nodes: [] }
    })
    const { fetch } = fakeGitHub([ok(fixture('graphql-reviews.json'))], [ok(threads)])

    const [thread] = (await fetchWith(fetch)).threads

    expect(thread).toMatchObject({ author: '', body: '', reviewId: null, replies: [] })
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

describe('fetchPullComments', () => {
  const comments = (pages: FakeResponse[]) => createFakeFetch({ comments: pages }, () => 'comments')
  const read = (fetch: typeof globalThis.fetch) =>
    fetchPullComments({ owner: 'saulosw', repo: 'phada-dev-web', number: 11, token: TOKEN, fetch })

  it('reads the general comments of the pull request with their author and date', async () => {
    const { fetch, calls } = comments([ok(fixture('graphql-comments.json'))])

    expect(await read(fetch)).toEqual([
      {
        id: 'IC_kwDOQNCyRM7cQ1aa',
        author: 'saulosw',
        bot: false,
        association: 'OWNER',
        createdAt: '2026-10-07T21:03:11Z',
        body: 'The retry is temporary, it goes away in the next pull request.',
      },
      {
        id: 'IC_kwDOQNCyRM7cQ1bb',
        author: 'codecov',
        bot: true,
        association: 'NONE',
        createdAt: '2026-10-07T21:05:42Z',
        body: 'Coverage dropped by 0.4%.',
      },
    ])
    expect(variablesOf(calls[0])).toEqual({
      owner: 'saulosw',
      repo: 'phada-dev-web',
      number: 11,
      after: null,
    })
  })

  it('follows the cursor and reads a deleted author as an empty login', async () => {
    const first = withPage(fixture('graphql-comments.json'), 'comments', (root) => {
      root.pageInfo = { hasNextPage: true, endCursor: 'C1' }
    })
    const second = withPage(fixture('graphql-comments.json'), 'comments', (root) => {
      root.nodes = [{ ...(root.nodes as Json[])[0]!, id: 'IC_last', author: null }]
    })
    const { fetch, calls } = comments([ok(first), ok(second)])

    const all = await read(fetch)

    expect(all.map(({ id, author }) => [id, author])).toEqual([
      ['IC_kwDOQNCyRM7cQ1aa', 'saulosw'],
      ['IC_kwDOQNCyRM7cQ1bb', 'codecov'],
      ['IC_last', ''],
    ])
    expect(calls.map((call) => variablesOf(call).after)).toEqual([null, 'C1'])
  })

  it('throws PullRequestNotFoundError for NOT_FOUND', async () => {
    const { fetch } = comments([ok(fixture('graphql-not-found.json'))])

    expect(await failureOf(read(fetch))).toBeInstanceOf(PullRequestNotFoundError)
  })
})
