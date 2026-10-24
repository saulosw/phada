import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import { addCommentReaction, listIssueComments } from './issue-comments.js'

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const JSON_ACCEPT = 'application/vnd.github+json'
const comment = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  body: '/phada review',
  user: { login: 'alice', type: 'User' },
  author_association: 'MEMBER',
  created_at: '2026-10-23T12:00:00Z',
  html_url: `https://github.com/acme/shop/pull/12#issuecomment-${id}`,
  issue_url: 'https://api.github.com/repos/acme/shop/issues/12',
  ...overrides,
})

describe('listIssueComments', () => {
  it('lists the comments of the repository since a time, oldest first, with their pull request', async () => {
    const body = JSON.stringify([
      comment(1),
      comment(2, {
        html_url: 'https://github.com/acme/shop/issues/5#issuecomment-2',
        issue_url: 'https://api.github.com/repos/acme/shop/issues/5',
        user: { login: 'bot', type: 'Bot' },
      }),
    ])
    const { fetch, calls } = createFakeFetch({
      [JSON_ACCEPT]: [{ status: 200, body, headers: { etag: 'W/"c"' } }],
    })

    const listed = await listIssueComments({
      owner: 'acme',
      repo: 'shop',
      token: TOKEN,
      fetch,
      since: '2026-10-23T11:00:00.000Z',
    })

    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/acme/shop/issues/comments?since=2026-10-23T11%3A00%3A00.000Z&sort=created&direction=asc&per_page=100',
    )
    expect(listed).toEqual({
      status: 'ok',
      etag: 'W/"c"',
      comments: [
        {
          id: 1,
          body: '/phada review',
          author: 'alice',
          authorIsBot: false,
          association: 'MEMBER',
          createdAt: '2026-10-23T12:00:00Z',
          url: 'https://github.com/acme/shop/pull/12#issuecomment-1',
          number: 12,
          pullRequest: true,
        },
        expect.objectContaining({ id: 2, number: 5, pullRequest: false, authorIsBot: true }),
      ],
    })
  })

  it('sends the stored ETag and answers not-modified on 304', async () => {
    const { fetch, calls } = createFakeFetch({ [JSON_ACCEPT]: [{ status: 304 }] })

    expect(
      await listIssueComments({
        owner: 'acme',
        repo: 'shop',
        token: TOKEN,
        fetch,
        since: '2026-10-23T11:00:00.000Z',
        etag: 'W/"c"',
      }),
    ).toEqual({ status: 'not-modified' })
    expect(calls[0]?.headers['if-none-match']).toBe('W/"c"')
  })
})

describe('addCommentReaction', () => {
  it('adds the eyes reaction to a comment', async () => {
    const { fetch, calls } = createFakeFetch({ [JSON_ACCEPT]: [{ status: 201, body: '{}' }] })

    await addCommentReaction({ owner: 'acme', repo: 'shop', token: TOKEN, fetch, commentId: 7 })

    expect(calls[0]).toMatchObject({
      url: 'https://api.github.com/repos/acme/shop/issues/comments/7/reactions',
      method: 'POST',
      body: '{"content":"eyes"}',
    })
  })
})
