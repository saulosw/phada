import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import { ACCEPT_JSON } from './request.js'
import { repositoryReader } from './read-repository.js'

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'

describe('repositoryReader', () => {
  it('reads a path of the repository with GET and the token', async () => {
    const github = createFakeFetch({ [ACCEPT_JSON]: [{ status: 200, body: '[{"number":1}]' }] })
    const read = repositoryReader({ repo: 'acme/shop', token: TOKEN, fetch: github.fetch })

    expect(await read('repos/acme/shop/pulls', { state: 'open' })).toEqual([{ number: 1 }])
    expect(github.calls[0]?.url).toBe('https://api.github.com/repos/acme/shop/pulls?state=open')
    expect(github.calls[0]?.method).toBeUndefined()
    expect(github.calls[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`)
  })

  it('reads the issue search', async () => {
    const github = createFakeFetch({ [ACCEPT_JSON]: [{ status: 200, body: '{"items":[]}' }] })
    const read = repositoryReader({ repo: 'acme/shop', token: TOKEN, fetch: github.fetch })

    await read('search/issues', { q: 'x repo:acme/shop' })

    expect(github.calls[0]?.url).toBe('https://api.github.com/search/issues?q=x+repo%3Aacme%2Fshop')
  })

  it.each([
    'repos/other/repo/pulls',
    'repos/acme/shopping',
    'user',
    'repos/acme/shop/../../x',
    'repos/acme/shop/%2e%2e/%2e%2e/victim/private/contents/.env',
    'repos/acme/shop/%2E%2E/x',
    'repos/acme/shop/./pulls',
    'repos/acme/shop\\..\\x',
    'repos/acme/shop/actions/variables',
    'repos/acme/shop/hooks',
    'repos/acme/shop/secret-scanning/alerts',
    'repos/acme/shop/collaborators',
  ])('refuses %s without a request', async (path) => {
    const github = createFakeFetch({})
    const read = repositoryReader({ repo: 'acme/shop', token: TOKEN, fetch: github.fetch })

    await expect(read(path)).rejects.toThrow('Only acme/shop can be read during this review.')
    expect(github.calls).toEqual([])
  })
})

describe('repositoryReader allowed reads', () => {
  it.each([
    'repos/acme/shop',
    'repos/acme/shop/pulls/12/files',
    'repos/acme/shop/issues/3/comments',
    'repos/acme/shop/commits/abc',
    'repos/acme/shop/contents/README.md',
    'repos/acme/shop/git/trees/abc',
    'repos/acme/shop/compare/a...b',
  ])('reads %s', async (path) => {
    const github = createFakeFetch({ [ACCEPT_JSON]: [{ status: 200, body: '{}' }] })
    const read = repositoryReader({ repo: 'acme/shop', token: TOKEN, fetch: github.fetch })

    await read(path)

    expect(github.calls).toHaveLength(1)
  })
})

describe('repositoryReader search', () => {
  it.each([
    'x repo:victim/private',
    'x org:victim',
    'x user:victim',
    'x repo:acme/shop repo:victim/private',
  ])('refuses a search that names another scope: %s', async (q) => {
    const github = createFakeFetch({})
    const read = repositoryReader({ repo: 'acme/shop', token: TOKEN, fetch: github.fetch })

    await expect(read('search/issues', { q: `${q} repo:acme/shop` })).rejects.toThrow(
      'Only acme/shop can be searched during this review.',
    )
    expect(github.calls).toEqual([])
  })

  it('refuses a search without the repository', async () => {
    const read = repositoryReader({
      repo: 'acme/shop',
      token: TOKEN,
      fetch: createFakeFetch({}).fetch,
    })

    await expect(read('search/issues', { q: 'x' })).rejects.toThrow(
      'Only acme/shop can be searched during this review.',
    )
  })
})
