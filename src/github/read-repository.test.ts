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

  it.each(['repos/other/repo/pulls', 'repos/acme/shopping', 'user', 'repos/acme/shop/../../x'])(
    'refuses %s without a request',
    async (path) => {
      const github = createFakeFetch({})
      const read = repositoryReader({ repo: 'acme/shop', token: TOKEN, fetch: github.fetch })

      await expect(read(path)).rejects.toThrow('Only acme/shop can be read during this review.')
      expect(github.calls).toEqual([])
    },
  )
})
