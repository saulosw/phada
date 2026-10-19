import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import { listOpenPullRequests, MAX_PULL_PAGES } from './list-pull-requests.js'
import { RepositoryAccessError } from './repository.js'

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const JSON_ACCEPT = 'application/vnd.github+json'
const LIST = readFileSync('test/fixtures/github/pulls-list.json', 'utf8')
const FIRST =
  'https://api.github.com/repos/acme/shop/pulls?state=open&sort=updated&direction=desc&per_page=100'
const options = (fetch: typeof globalThis.fetch, etag?: string) => ({
  owner: 'acme',
  repo: 'shop',
  token: TOKEN,
  fetch,
  ...(etag === undefined ? {} : { etag }),
})

describe('listOpenPullRequests', () => {
  it('lists the open pull requests with what the watch filters on', async () => {
    const { fetch, calls } = createFakeFetch({
      [JSON_ACCEPT]: [{ status: 200, body: LIST, headers: { etag: 'W/"one"' } }],
    })

    const listed = await listOpenPullRequests(options(fetch))

    expect(calls[0]?.url).toBe(FIRST)
    expect(calls[0]?.headers['if-none-match']).toBeUndefined()
    expect(listed).toEqual({
      status: 'ok',
      etag: 'W/"one"',
      pulls: [
        {
          number: 12,
          headSha: 'a'.repeat(40),
          draft: false,
          author: 'alice',
          authorIsBot: false,
          association: 'MEMBER',
          labels: ['phada'],
          baseRef: 'main',
          private: false,
        },
        expect.objectContaining({ number: 11, author: 'dependabot[bot]', authorIsBot: true }),
        expect.objectContaining({
          number: 10,
          authorIsBot: true,
          draft: true,
          association: 'CONTRIBUTOR',
          baseRef: 'dev',
          labels: [],
        }),
      ],
    })
  })

  it('sends the stored ETag and answers not-modified on 304', async () => {
    const { fetch, calls } = createFakeFetch({ [JSON_ACCEPT]: [{ status: 304 }] })

    expect(await listOpenPullRequests(options(fetch, 'W/"one"'))).toEqual({
      status: 'not-modified',
    })
    expect(calls[0]?.headers['if-none-match']).toBe('W/"one"')
  })

  it('reads the next pages and keeps the ETag of the first one', async () => {
    const next = `${FIRST}&page=2`
    const { fetch, calls } = createFakeFetch({
      [JSON_ACCEPT]: [
        {
          status: 200,
          body: JSON.stringify(JSON.parse(LIST).slice(0, 1)),
          headers: { etag: 'W/"first"', link: `<${next}>; rel="next", <${next}>; rel="last"` },
        },
        {
          status: 200,
          body: JSON.stringify(JSON.parse(LIST).slice(1)),
          headers: { etag: 'W/"second"' },
        },
      ],
    })

    const listed = await listOpenPullRequests(options(fetch))

    expect(calls.map((call) => call.url)).toEqual([FIRST, next])
    expect(calls[1]?.headers['if-none-match']).toBeUndefined()
    expect(listed).toMatchObject({ status: 'ok', etag: 'W/"first"' })
    expect(listed.status === 'ok' ? listed.pulls.map((pull) => pull.number) : []).toEqual([
      12, 11, 10,
    ])
  })

  it(`stops after ${MAX_PULL_PAGES} pages`, async () => {
    const page = (n: number) => ({
      status: 200,
      body: '[]',
      headers: { link: `<${FIRST}&page=${n + 1}>; rel="next"` },
    })
    const { fetch, calls } = createFakeFetch({
      [JSON_ACCEPT]: Array.from({ length: MAX_PULL_PAGES + 2 }, (_, n) => page(n + 1)),
    })

    await listOpenPullRequests(options(fetch))

    expect(calls).toHaveLength(MAX_PULL_PAGES)
  })

  it('never follows a next link outside the GitHub API', async () => {
    const { fetch, calls } = createFakeFetch({
      [JSON_ACCEPT]: [
        {
          status: 200,
          body: '[]',
          headers: { link: '<https://evil.example/pulls?page=2>; rel="next"' },
        },
      ],
    })

    await listOpenPullRequests(options(fetch))

    expect(calls).toHaveLength(1)
  })

  it('throws RepositoryAccessError for a repository the token cannot read', async () => {
    const { fetch } = createFakeFetch({ [JSON_ACCEPT]: [{ status: 404, body: '{}' }] })

    await expect(listOpenPullRequests(options(fetch))).rejects.toBeInstanceOf(RepositoryAccessError)
  })
})
