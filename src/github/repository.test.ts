import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import { GitHubRateLimitError } from './errors.js'
import { fetchBranchHead, fetchRepository, RepositoryAccessError } from './repository.js'

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const JSON_ACCEPT = 'application/vnd.github+json'

const repositoryBody = (fields: Record<string, unknown>) =>
  JSON.stringify({
    full_name: 'acme/web',
    private: true,
    default_branch: 'main',
    archived: false,
    size: 120,
    ...fields,
  })

describe('fetchRepository', () => {
  it('reads the visibility, the default branch and whether it is empty', async () => {
    const { fetch, calls } = createFakeFetch({
      [JSON_ACCEPT]: [{ status: 200, body: repositoryBody({ archived: true }) }],
    })

    const info = await fetchRepository({ owner: 'acme', repo: 'web', token: TOKEN, fetch })

    expect(info).toEqual({ repo: 'acme/web', private: true, defaultBranch: 'main', empty: false })
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/web')
  })

  it('calls a repository without commits empty', async () => {
    const { fetch } = createFakeFetch({
      [JSON_ACCEPT]: [{ status: 200, body: repositoryBody({ size: 0, default_branch: null }) }],
    })

    const info = await fetchRepository({ owner: 'acme', repo: 'web', token: TOKEN, fetch })

    expect(info).toEqual({ repo: 'acme/web', private: true, empty: true })
  })

  it('keeps a new repository whose size GitHub has not computed yet', async () => {
    const { fetch } = createFakeFetch({
      [JSON_ACCEPT]: [{ status: 200, body: repositoryBody({ size: 0 }) }],
    })

    const info = await fetchRepository({ owner: 'acme', repo: 'web', token: TOKEN, fetch })

    expect(info.empty).toBe(false)
  })

  it.each([404, 403])(
    'turns HTTP %i into an access error that names the repository',
    async (status) => {
      const { fetch } = createFakeFetch({
        [JSON_ACCEPT]: [{ status, body: JSON.stringify({ message: `Not Found ${TOKEN}` }) }],
      })

      const failure = fetchRepository({ owner: 'acme', repo: 'web', token: TOKEN, fetch })

      await expect(failure).rejects.toBeInstanceOf(RepositoryAccessError)
      await expect(failure).rejects.toThrow(/acme\/web/)
      await expect(failure).rejects.not.toThrow(TOKEN)
    },
  )

  it('keeps a rate limit a rate limit', async () => {
    const { fetch } = createFakeFetch({
      [JSON_ACCEPT]: [
        {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' },
          body: JSON.stringify({ message: 'API rate limit exceeded' }),
        },
      ],
    })

    await expect(
      fetchRepository({ owner: 'acme', repo: 'web', token: TOKEN, fetch }),
    ).rejects.toBeInstanceOf(GitHubRateLimitError)
  })
})

describe('fetchBranchHead', () => {
  const SHA_ACCEPT = 'application/vnd.github.sha'

  it('reads the commit at the tip of a branch', async () => {
    const { fetch, calls } = createFakeFetch({
      [SHA_ACCEPT]: [{ status: 200, body: 'd'.repeat(40), headers: { etag: '"tip"' } }],
    })

    const head = await fetchBranchHead({
      owner: 'acme',
      repo: 'web',
      branch: 'main',
      token: TOKEN,
      fetch,
    })

    expect(head).toEqual({ status: 'ok', sha: 'd'.repeat(40), etag: '"tip"' })
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/web/commits/main')
  })

  it('answers not-modified when the ETag still matches', async () => {
    const { fetch, calls } = createFakeFetch({ [SHA_ACCEPT]: [{ status: 304 }] })

    const head = await fetchBranchHead({
      owner: 'acme',
      repo: 'web',
      branch: 'release/1.0',
      token: TOKEN,
      fetch,
      etag: '"tip"',
    })

    expect(head).toEqual({ status: 'not-modified' })
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/web/commits/release%2F1.0')
    expect(calls[0]?.headers['if-none-match']).toBe('"tip"')
  })
})
