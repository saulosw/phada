import { describe, expect, it } from 'vitest'
import type { UserRepository } from '../github/user-repositories.js'
import { readUserRepositories } from './read-user-repositories.js'
import type { UserRepositoryReaders } from './read-user-repositories.js'

const SHOP: UserRepository = {
  name: 'acme/shop',
  private: true,
  fork: false,
  pushedAt: '2026-10-26T18:00:00Z',
}
const INK: UserRepository = {
  name: 'ana/ink',
  private: false,
  fork: true,
  pushedAt: '2026-10-12T15:30:00Z',
}
const BLOG: UserRepository = {
  name: 'Ana/Blog',
  private: false,
  fork: false,
  pushedAt: '2026-10-01T08:00:00Z',
}

function readers(overrides: Partial<UserRepositoryReaders> = {}): UserRepositoryReaders {
  return {
    token: async () => 'token',
    listRepositories: async () => [SHOP, INK, BLOG],
    watchedRepos: async () => [],
    ...overrides,
  }
}

describe('readUserRepositories', () => {
  it('lists the repositories as GitHub orders them when none is watched', async () => {
    const listed: string[] = []
    const read = await readUserRepositories(
      readers({
        listRepositories: async (token) => {
          listed.push(token)
          return [SHOP, INK, BLOG]
        },
      }),
    )

    expect(listed).toEqual(['token'])
    expect(read).toEqual({
      status: 'listed',
      repositories: [
        { ...SHOP, watched: false, listed: true },
        { ...INK, watched: false, listed: true },
        { ...BLOG, watched: false, listed: true },
      ],
    })
  })

  it('marks the watched repositories and puts them first, whatever their case', async () => {
    const read = await readUserRepositories(
      readers({ watchedRepos: async () => ['ana/blog', 'ana/ink'] }),
    )

    expect(read.status === 'listed' && read.repositories).toEqual([
      { ...INK, watched: true, listed: true },
      { ...BLOG, watched: true, listed: true },
      { ...SHOP, watched: false, listed: true },
    ])
  })

  it('keeps a watched repository GitHub did not list, after the listed watched ones', async () => {
    const read = await readUserRepositories(
      readers({ watchedRepos: async () => ['other/lib', 'acme/shop'] }),
    )

    expect(read.status === 'listed' && read.repositories.map(({ name }) => name)).toEqual([
      'acme/shop',
      'other/lib',
      'ana/ink',
      'Ana/Blog',
    ])
    expect(read.status === 'listed' && read.repositories[1]).toEqual({
      name: 'other/lib',
      watched: true,
      listed: false,
    })
  })

  it('answers no-token without listing, with the watched repositories', async () => {
    let listed = false
    const read = await readUserRepositories(
      readers({
        token: async () => undefined,
        listRepositories: async () => {
          listed = true
          return []
        },
        watchedRepos: async () => ['acme/shop'],
      }),
    )

    expect(read).toEqual({
      status: 'no-token',
      repositories: [{ name: 'acme/shop', watched: true, listed: false }],
    })
    expect(listed).toBe(false)
  })

  it('keeps the watched repositories and the error when the listing fails', async () => {
    const read = await readUserRepositories(
      readers({
        listRepositories: async () => {
          throw new Error('GitHub denied reading the repositories of the token owner (HTTP 403)')
        },
        watchedRepos: async () => ['acme/shop'],
      }),
    )

    expect(read).toEqual({
      status: 'failed',
      error: 'GitHub denied reading the repositories of the token owner (HTTP 403)',
      repositories: [{ name: 'acme/shop', watched: true, listed: false }],
    })
  })
})
