import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import { GitHubAuthError, GitHubRequestError } from './errors.js'
import { ACCEPT_RAW, fetchRepositoryFile, fetchRepositoryTree } from './repository-files.js'

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const SHA = 'b1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const JSON_ACCEPT = 'application/vnd.github+json'

function treeBody(tree: unknown[], truncated = false): string {
  return JSON.stringify({ sha: SHA, tree, truncated })
}

describe('fetchRepositoryTree', () => {
  it('lists the files of a commit with their sizes, skipping folders, links and submodules', async () => {
    const { fetch, calls } = createFakeFetch({
      [JSON_ACCEPT]: [
        {
          status: 200,
          body: treeBody([
            { path: 'a.md', mode: '100644', type: 'blob', size: 10 },
            { path: 'src', mode: '040000', type: 'tree' },
            { path: 'link.md', mode: '120000', type: 'blob', size: 4 },
            { path: 'vendor/mod', mode: '160000', type: 'commit' },
            { path: 'src/x.ts', mode: '100755', type: 'blob', size: 3 },
          ]),
        },
      ],
    })

    const tree = await fetchRepositoryTree({
      owner: 'acme',
      repo: 'shop',
      sha: SHA,
      token: TOKEN,
      fetch,
    })

    expect(tree).toEqual({
      entries: [
        { path: 'a.md', size: 10 },
        { path: 'src/x.ts', size: 3 },
      ],
      truncated: false,
    })
    expect(calls[0]?.url).toBe(
      `https://api.github.com/repos/acme/shop/git/trees/${SHA}?recursive=1`,
    )
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`)
  })

  it('passes the truncated flag on', async () => {
    const { fetch } = createFakeFetch({
      [JSON_ACCEPT]: [{ status: 200, body: treeBody([], true) }],
    })

    const tree = await fetchRepositoryTree({
      owner: 'acme',
      repo: 'shop',
      sha: SHA,
      token: TOKEN,
      fetch,
    })

    expect(tree.truncated).toBe(true)
  })

  it('fails with the GitHub error of a token that cannot read contents', async () => {
    const { fetch } = createFakeFetch({
      [JSON_ACCEPT]: [
        { status: 403, body: JSON.stringify({ message: 'Resource not accessible' }) },
      ],
    })

    await expect(
      fetchRepositoryTree({ owner: 'acme', repo: 'shop', sha: SHA, token: TOKEN, fetch }),
    ).rejects.toBeInstanceOf(GitHubAuthError)
  })

  it('fails on a missing commit', async () => {
    const { fetch } = createFakeFetch({ [JSON_ACCEPT]: [{ status: 404, body: '{}' }] })

    await expect(
      fetchRepositoryTree({ owner: 'acme', repo: 'shop', sha: SHA, token: TOKEN, fetch }),
    ).rejects.toBeInstanceOf(GitHubRequestError)
  })

  it('rejects a tree entry without a path', async () => {
    const { fetch } = createFakeFetch({
      [JSON_ACCEPT]: [{ status: 200, body: treeBody([{ type: 'blob', mode: '100644', size: 1 }]) }],
    })

    await expect(
      fetchRepositoryTree({ owner: 'acme', repo: 'shop', sha: SHA, token: TOKEN, fetch }),
    ).rejects.toThrow('Unexpected GitHub response: missing or invalid "tree"')
  })
})

describe('fetchRepositoryFile', () => {
  it('reads the raw file at a commit with each path segment encoded', async () => {
    const { fetch, calls } = createFakeFetch({
      [ACCEPT_RAW]: [{ status: 200, body: '# Arquitetura' }],
    })

    const text = await fetchRepositoryFile({
      owner: 'acme',
      repo: 'shop',
      path: 'docs/Arquitetura é.md',
      ref: SHA,
      token: TOKEN,
      fetch,
    })

    expect(text).toBe('# Arquitetura')
    expect(calls[0]?.url).toBe(
      `https://api.github.com/repos/acme/shop/contents/docs/Arquitetura%20%C3%A9.md?ref=${SHA}`,
    )
  })

  it('returns null for a missing file', async () => {
    const { fetch } = createFakeFetch({ [ACCEPT_RAW]: [{ status: 404, body: '{}' }] })

    expect(
      await fetchRepositoryFile({
        owner: 'acme',
        repo: 'shop',
        path: 'x.md',
        ref: SHA,
        token: TOKEN,
        fetch,
      }),
    ).toBeNull()
  })

  it('redacts the token from an error', async () => {
    const { fetch } = createFakeFetch({ [ACCEPT_RAW]: [{ status: 500, body: `boom ${TOKEN}` }] })

    const error = await fetchRepositoryFile({
      owner: 'acme',
      repo: 'shop',
      path: 'x.md',
      ref: SHA,
      token: TOKEN,
      fetch,
    }).catch((caught: unknown) => caught)

    expect(String(error)).not.toContain(TOKEN)
    expect(String(error)).toContain('[REDACTED]')
  })
})
