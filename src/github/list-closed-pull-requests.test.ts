import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import type { FakeResponse } from '../../test/support/fake-fetch.js'
import { listClosedPullRequests } from './list-closed-pull-requests.js'
import { MAX_PULL_PAGES } from './list-pull-requests.js'
import { RepositoryAccessError } from './repository.js'

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const JSON_ACCEPT = 'application/vnd.github+json'
const FIRST =
  'https://api.github.com/repos/acme/shop/pulls?state=closed&sort=updated&direction=desc&per_page=100'
const SINCE = '2026-10-01T00:00:00.000Z'

const pull = (number: number, closedAt: string | null, updatedAt = closedAt ?? SINCE) => ({
  number,
  state: 'closed',
  closed_at: closedAt,
  merged_at: null,
  updated_at: updatedAt,
})

const page = (items: unknown[], next?: number): FakeResponse => ({
  status: 200,
  body: JSON.stringify(items),
  headers: next === undefined ? {} : { link: `<${FIRST}&page=${next}>; rel="next"` },
})

const numbers = (pulls: readonly { number: number }[]) => pulls.map(({ number }) => number)

const options = (fetch: typeof globalThis.fetch, limit?: number) => ({
  owner: 'acme',
  repo: 'shop',
  token: TOKEN,
  since: SINCE,
  fetch,
  ...(limit === undefined ? {} : { limit }),
})

describe('listClosedPullRequests', () => {
  it('lists the pull requests closed since the date, the most recently closed first', async () => {
    const { fetch, calls } = createFakeFetch({
      [JSON_ACCEPT]: [
        page([
          pull(7, '2026-10-02T10:00:00Z', '2026-10-20T10:00:00Z'),
          pull(9, '2026-10-15T10:00:00Z'),
          pull(4, '2026-09-30T23:59:59Z', '2026-10-10T00:00:00Z'),
          pull(8, '2026-10-01T00:00:00Z'),
        ]),
      ],
    })

    expect(await listClosedPullRequests(options(fetch))).toEqual([
      { number: 9, closedAt: '2026-10-15T10:00:00Z' },
      { number: 7, closedAt: '2026-10-02T10:00:00Z' },
      { number: 8, closedAt: '2026-10-01T00:00:00Z' },
    ])
    expect(calls.map(({ url }) => url)).toEqual([FIRST])
  })

  it('stops reading pages once a page was all updated before the date', async () => {
    const { fetch, calls } = createFakeFetch({
      [JSON_ACCEPT]: [
        page([pull(12, '2026-10-12T00:00:00Z')], 2),
        page([pull(11, '2026-09-20T00:00:00Z', '2026-10-03T00:00:00Z')], 3),
        page([pull(10, '2026-09-10T00:00:00Z', '2026-09-28T00:00:00Z')], 4),
        page([pull(3, '2026-10-05T00:00:00Z')]),
      ],
    })

    expect(numbers(await listClosedPullRequests(options(fetch)))).toEqual([12])
    expect(calls).toHaveLength(3)
  })

  it('keeps at most the limit, 50 by default, cutting the oldest closed', async () => {
    const items = Array.from({ length: 60 }, (_, index) =>
      pull(index + 1, `2026-10-${String(1 + (index % 28)).padStart(2, '0')}T00:00:00Z`),
    )
    const { fetch } = createFakeFetch({ [JSON_ACCEPT]: [page(items)] })

    const listed = numbers(await listClosedPullRequests(options(fetch)))

    expect(listed).toHaveLength(50)
    expect(listed.slice(0, 3)).toEqual([28, 56, 27])
    expect(listed).not.toContain(1)
  })

  it('keeps reading pages past the limit, since a pull request closed later can be updated earlier', async () => {
    const { fetch, calls } = createFakeFetch({
      [JSON_ACCEPT]: [
        page(
          [
            pull(5, '2026-10-05T00:00:00Z', '2026-10-20T00:00:00Z'),
            pull(6, '2026-10-06T00:00:00Z', '2026-10-19T00:00:00Z'),
          ],
          2,
        ),
        page([pull(9, '2026-10-09T00:00:00Z')]),
      ],
    })

    expect(numbers(await listClosedPullRequests(options(fetch, 2)))).toEqual([9, 6])
    expect(calls).toHaveLength(2)
  })

  it('reads 250 pull requests over three pages and keeps the 200 most recently closed', async () => {
    const closedAt = (n: number) => new Date(Date.parse(SINCE) + n * 60_000).toISOString()
    const pages = [0, 1, 2].map((p) =>
      page(
        Array.from({ length: p === 2 ? 50 : 100 }, (_, i) =>
          pull(250 - (p * 100 + i), closedAt(250 - (p * 100 + i))),
        ),
        p === 2 ? undefined : p + 2,
      ),
    )
    const { fetch, calls } = createFakeFetch({ [JSON_ACCEPT]: pages })

    const listed = numbers(await listClosedPullRequests(options(fetch, 200)))

    expect(calls).toHaveLength(3)
    expect(listed).toHaveLength(200)
    expect(listed[0]).toBe(250)
    expect(listed.at(-1)).toBe(51)
  })

  it(`stops after ${MAX_PULL_PAGES} pages`, async () => {
    const { fetch, calls } = createFakeFetch({
      [JSON_ACCEPT]: Array.from({ length: MAX_PULL_PAGES + 2 }, (_, n) =>
        page([pull(100 + n, null, '2026-10-20T00:00:00Z')], n + 2),
      ),
    })

    expect(await listClosedPullRequests(options(fetch))).toEqual([])
    expect(calls).toHaveLength(MAX_PULL_PAGES)
  })

  it.each([404, 403])('throws RepositoryAccessError when GitHub answers %i', async (status) => {
    const { fetch } = createFakeFetch({ [JSON_ACCEPT]: [{ status, body: '{}' }] })

    await expect(listClosedPullRequests(options(fetch))).rejects.toBeInstanceOf(
      RepositoryAccessError,
    )
  })
})
