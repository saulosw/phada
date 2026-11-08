import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import { MAX_COMMENT_PAGES } from './issue-comments.js'
import { listReviewComments } from './review-comments.js'

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const JSON_ACCEPT = 'application/vnd.github+json'
const comment = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  node_id: `PRRC_${id}`,
  in_reply_to_id: 7,
  body: 'Why?',
  user: { login: 'alice', type: 'User' },
  author_association: 'MEMBER',
  created_at: '2026-11-08T12:00:00Z',
  html_url: `https://github.com/acme/shop/pull/12#discussion_r${id}`,
  pull_request_url: 'https://api.github.com/repos/acme/shop/pulls/12',
  ...overrides,
})

describe('listReviewComments', () => {
  it('lists the review comments of the repository since a time, oldest first, with their pull request', async () => {
    const body = JSON.stringify([
      comment(8),
      comment(9, {
        in_reply_to_id: undefined,
        user: { login: 'ci', type: 'Bot' },
        pull_request_url: 'https://api.github.com/repos/acme/shop/pulls/5',
      }),
    ])
    const { fetch, calls } = createFakeFetch({
      [JSON_ACCEPT]: [{ status: 200, body, headers: { etag: 'W/"r"' } }],
    })

    const listed = await listReviewComments({
      owner: 'acme',
      repo: 'shop',
      token: TOKEN,
      fetch,
      since: '2026-11-08T11:00:00.000Z',
    })

    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/acme/shop/pulls/comments?since=2026-11-08T11%3A00%3A00.000Z&sort=created&direction=asc&per_page=100',
    )
    expect(listed).toEqual({
      status: 'ok',
      etag: 'W/"r"',
      comments: [
        {
          id: 8,
          inReplyTo: 7,
          number: 12,
          author: 'alice',
          authorIsBot: false,
          association: 'MEMBER',
          createdAt: '2026-11-08T12:00:00Z',
        },
        {
          id: 9,
          number: 5,
          author: 'ci',
          authorIsBot: true,
          association: 'MEMBER',
          createdAt: '2026-11-08T12:00:00Z',
        },
      ],
    })
  })

  it('sends the stored ETag and answers not-modified on 304', async () => {
    const { fetch, calls } = createFakeFetch({ [JSON_ACCEPT]: [{ status: 304 }] })

    expect(
      await listReviewComments({
        owner: 'acme',
        repo: 'shop',
        token: TOKEN,
        fetch,
        since: '2026-11-08T11:00:00.000Z',
        etag: 'W/"r"',
      }),
    ).toEqual({ status: 'not-modified' })
    expect(calls[0]?.headers['if-none-match']).toBe('W/"r"')
  })

  it('reads at most a few pages in one call', async () => {
    const page = (id: number) => ({
      status: 200,
      body: JSON.stringify([comment(id)]),
      headers: {
        link: `<https://api.github.com/repos/acme/shop/pulls/comments?page=${id + 1}>; rel="next"`,
      },
    })
    const { fetch, calls } = createFakeFetch({
      [JSON_ACCEPT]: Array.from({ length: MAX_COMMENT_PAGES + 2 }, (_, index) => page(index + 1)),
    })

    const listed = await listReviewComments({
      owner: 'acme',
      repo: 'shop',
      token: TOKEN,
      fetch,
      since: '2026-11-08T11:00:00.000Z',
    })

    expect(calls).toHaveLength(MAX_COMMENT_PAGES)
    expect(listed.status === 'ok' && listed.comments.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5])
  })
})
