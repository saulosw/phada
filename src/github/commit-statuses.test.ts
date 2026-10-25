import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import { fetchCommitStatuses } from './commit-statuses.js'
import { GitHubPermissionError } from './errors.js'

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const SHA = 'b'.repeat(40)
const JSON_ACCEPT = 'application/vnd.github+json'
const OPTIONS = { owner: 'acme', repo: 'shop', token: TOKEN, sha: SHA }

describe('fetchCommitStatuses', () => {
  it('reads the latest status of each context of a commit, on every page', async () => {
    const next = `<https://api.github.com/repos/acme/shop/commits/${SHA}/status?per_page=100&page=2>; rel="next"`
    const { fetch, calls } = createFakeFetch({
      [JSON_ACCEPT]: [
        {
          status: 200,
          headers: { link: next },
          body: JSON.stringify({
            state: 'failure',
            total_count: 2,
            statuses: [
              {
                context: 'ci/build',
                state: 'failure',
                description: 'Build failed',
                target_url: 'https://ci.example.com/1',
              },
            ],
          }),
        },
        {
          status: 200,
          body: JSON.stringify({
            state: 'failure',
            total_count: 2,
            statuses: [
              { context: 'deploy/preview', state: 'pending', description: null, target_url: null },
            ],
          }),
        },
      ],
    })

    const statuses = await fetchCommitStatuses({ ...OPTIONS, fetch })

    expect(calls[0]?.url).toBe(
      `https://api.github.com/repos/acme/shop/commits/${SHA}/status?per_page=100`,
    )
    expect(statuses).toEqual([
      {
        context: 'ci/build',
        state: 'failure',
        description: 'Build failed',
        url: 'https://ci.example.com/1',
      },
      { context: 'deploy/preview', state: 'pending', description: null, url: null },
    ])
  })

  it('reads no status when the combined status is pending with a count of zero', async () => {
    const { fetch } = createFakeFetch({
      [JSON_ACCEPT]: [
        { status: 200, body: JSON.stringify({ state: 'pending', total_count: 0, statuses: [] }) },
      ],
    })

    expect(await fetchCommitStatuses({ ...OPTIONS, fetch })).toEqual([])
  })

  it('names the statuses:read permission when GitHub denies the read', async () => {
    const { fetch } = createFakeFetch({
      [JSON_ACCEPT]: [{ status: 403, body: '{"message":"Resource not accessible"}' }],
    })

    const read = fetchCommitStatuses({ ...OPTIONS, fetch })

    await expect(read).rejects.toBeInstanceOf(GitHubPermissionError)
    await expect(read).rejects.toThrow('the token needs the statuses:read permission')
  })
})
