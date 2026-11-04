import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import type { FakeCall, FakeResponse } from '../../test/support/fake-fetch.js'
import { PullRequestNotFoundError } from './errors.js'
import { fetchPullRequestTimeline } from './pull-request-timeline.js'

const TOKEN = 'ghp_SECRET_test_token'
const OLD = '1e6a005c3b7d4e2f8a9b0c1d2e3f4a5b6c7d8e9f'
const NEW = 'e0fe8171a2b3c4d5e6f708192a3b4c5d6e7f8091'

type Json = Record<string, unknown>
const fixture = (): Json =>
  JSON.parse(
    readFileSync(
      new URL('../../test/fixtures/github/graphql-timeline.json', import.meta.url),
      'utf8',
    ),
  ) as Json
const ok = (body: unknown): FakeResponse => ({ status: 200, body: JSON.stringify(body) })

function timelineOf(page: Json): Json {
  return ((page.data as Json).repository as Json).pullRequest as Json
}

function fetchWith(answers: FakeResponse[]) {
  const fake = createFakeFetch({ graphql: answers }, () => 'graphql')
  return {
    result: fetchPullRequestTimeline({
      owner: 'acme',
      repo: 'shop',
      number: 12,
      token: TOKEN,
      fetch: fake.fetch,
    }),
    calls: fake.calls,
  }
}

function bodyOf(call: FakeCall | undefined): { query: string; variables: Json } {
  return JSON.parse(call?.body ?? '{}') as { query: string; variables: Json }
}

describe('fetchPullRequestTimeline', () => {
  it('reads the commits of the pull request and its force-pushes', async () => {
    const { result, calls } = fetchWith([ok(fixture())])

    expect(await result).toEqual({
      commits: [{ oid: OLD, committedDate: '2026-10-07T20:41:12Z' }],
      forcePushes: [
        {
          createdAt: '2026-10-08T10:15:00Z',
          before: { oid: OLD, committedDate: '2026-10-07T20:41:12Z' },
          after: { oid: NEW, committedDate: '2026-10-08T10:12:40Z' },
        },
        { createdAt: '2026-10-09T08:00:00Z', before: null, after: null },
      ],
    })
    const { query, variables } = bodyOf(calls[0])
    expect(query).toContain('itemTypes: [PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT]')
    expect(variables).toEqual({ owner: 'acme', repo: 'shop', number: 12, after: null })
  })

  it('follows the pages of the timeline', async () => {
    const first = fixture()
    const items = timelineOf(first).timelineItems as Json
    items.pageInfo = { hasNextPage: true, endCursor: 'NEXT' }
    items.nodes = (items.nodes as Json[]).slice(0, 1)
    const second = fixture()
    ;(timelineOf(second).timelineItems as Json).nodes = [
      {
        __typename: 'PullRequestCommit',
        commit: { oid: NEW, committedDate: '2026-10-08T10:12:40Z' },
      },
    ]
    const { result, calls } = fetchWith([ok(first), ok(second)])

    expect((await result).commits.map(({ oid }) => oid)).toEqual([OLD, NEW])
    expect(bodyOf(calls[1]).variables.after).toBe('NEXT')
  })

  it('throws PullRequestNotFoundError when the pull request does not exist', async () => {
    const { result } = fetchWith([ok({ data: { repository: { pullRequest: null } } })])

    await expect(result).rejects.toBeInstanceOf(PullRequestNotFoundError)
  })
})
