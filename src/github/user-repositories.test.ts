import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import { GitHubPermissionError, GitHubRequestError } from './errors.js'
import { listUserRepositories, MAX_REPO_PAGES } from './user-repositories.js'

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`
const JSON_ACCEPT = 'application/vnd.github+json'
const LIST = readFileSync('test/fixtures/github/user-repos.json', 'utf8')
const FIRST =
  'https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100'

describe('listUserRepositories', () => {
  it('lists the repositories of the token owner, without the archived ones', async () => {
    const { fetch, calls } = createFakeFetch({ [JSON_ACCEPT]: [{ status: 200, body: LIST }] })

    const repositories = await listUserRepositories({ token: TOKEN, fetch })

    expect(calls[0]?.url).toBe(FIRST)
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(repositories).toEqual([
      { name: 'acme/shop', private: true, fork: false, pushedAt: '2026-10-26T18:00:00Z' },
      { name: 'ana/ink', private: false, fork: true, pushedAt: '2026-10-12T15:30:00Z' },
      { name: 'ana/empty', private: false, fork: false, pushedAt: null },
    ])
  })

  it('reads the next pages in the order GitHub gives them', async () => {
    const items = JSON.parse(LIST) as unknown[]
    const next = `${FIRST}&page=2`
    const { fetch, calls } = createFakeFetch({
      [JSON_ACCEPT]: [
        {
          status: 200,
          body: JSON.stringify(items.slice(0, 1)),
          headers: { link: `<${next}>; rel="next", <${next}>; rel="last"` },
        },
        { status: 200, body: JSON.stringify(items.slice(1)) },
      ],
    })

    const repositories = await listUserRepositories({ token: TOKEN, fetch })

    expect(calls.map((call) => call.url)).toEqual([FIRST, next])
    expect(repositories.map(({ name }) => name)).toEqual(['acme/shop', 'ana/ink', 'ana/empty'])
  })

  it(`stops after ${MAX_REPO_PAGES} pages`, async () => {
    const page = (n: number) => ({
      status: 200,
      body: '[]',
      headers: { link: `<${FIRST}&page=${n + 1}>; rel="next"` },
    })
    const { fetch, calls } = createFakeFetch({
      [JSON_ACCEPT]: Array.from({ length: MAX_REPO_PAGES + 2 }, (_, n) => page(n + 1)),
    })

    await listUserRepositories({ token: TOKEN, fetch })

    expect(calls).toHaveLength(MAX_REPO_PAGES)
  })

  it('names the permission the token lacks on a 403, without the token', async () => {
    const { fetch } = createFakeFetch({
      [JSON_ACCEPT]: [
        {
          status: 403,
          body: JSON.stringify({ message: `Resource not accessible by token ${TOKEN}` }),
        },
      ],
    })

    const error = await listUserRepositories({ token: TOKEN, fetch }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(GitHubPermissionError)
    expect((error as Error).message).toContain('the repositories of the token owner')
    expect((error as Error).message).toContain('metadata:read')
    expect((error as Error).message).not.toContain(TOKEN)
  })

  it('fails with a request error when GitHub cannot be reached', async () => {
    const { fetch } = createFakeFetch({ [JSON_ACCEPT]: ['network-error'] })

    const error = await listUserRepositories({ token: TOKEN, fetch }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(GitHubRequestError)
    expect((error as Error).message).toBe('Could not reach GitHub')
    expect((error as Error).message).not.toContain(TOKEN)
  })
})
