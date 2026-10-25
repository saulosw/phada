import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import { GitHubAuthError, GitHubRateLimitError } from './errors.js'
import { fetchAuthenticatedUser } from './user.js'

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const JSON_ACCEPT = 'application/vnd.github+json'

describe('fetchAuthenticatedUser', () => {
  it('reads the login of the token owner, and nothing else', async () => {
    const { fetch, calls } = createFakeFetch({
      [JSON_ACCEPT]: [
        {
          status: 200,
          body: JSON.stringify({ login: 'ana', id: 7, email: 'ana@example.com', name: 'Ana' }),
        },
      ],
    })

    const user = await fetchAuthenticatedUser({ token: TOKEN, fetch })

    expect(user).toEqual({ login: 'ana' })
    expect(calls[0]?.url).toBe('https://api.github.com/user')
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`)
  })

  it('turns a refused token into an auth error without the token', async () => {
    const { fetch } = createFakeFetch({
      [JSON_ACCEPT]: [
        { status: 401, body: JSON.stringify({ message: `Bad credentials ${TOKEN}` }) },
      ],
    })

    const failure = fetchAuthenticatedUser({ token: TOKEN, fetch })

    await expect(failure).rejects.toBeInstanceOf(GitHubAuthError)
    await expect(failure).rejects.not.toThrow(TOKEN)
  })

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

    await expect(fetchAuthenticatedUser({ token: TOKEN, fetch })).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    )
  })

  it('fails when GitHub cannot be reached', async () => {
    const { fetch } = createFakeFetch({ [JSON_ACCEPT]: ['network-error'] })

    await expect(fetchAuthenticatedUser({ token: TOKEN, fetch })).rejects.toThrow()
  })
})
