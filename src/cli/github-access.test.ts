import { describe, expect, it } from 'vitest'
import { GitHubAuthError, GitHubRequestError } from '../github/errors.js'
import { readGitHubAccess } from './github-access.js'

const TOKEN = 'ghp_secret123'

function access(
  env: Record<string, string>,
  options: { gh?: string; user?: () => Promise<{ login: string }> } = {},
) {
  const tokens: string[] = []
  const read = readGitHubAccess({
    env,
    ghToken: async () => options.gh,
    fetchUser: async ({ token }) => {
      tokens.push(token)
      return (options.user ?? (async () => ({ login: 'ana' })))()
    },
  })
  return { read, tokens }
}

describe('readGitHubAccess', () => {
  it.each([
    ['GITHUB_TOKEN', { GITHUB_TOKEN: TOKEN, GH_TOKEN: 'ghp_other' }, undefined],
    ['GH_TOKEN', { GH_TOKEN: TOKEN }, undefined],
    ['gh', {}, TOKEN],
  ] as const)('names %s as where the token comes from, with its owner', async (source, env, gh) => {
    const { read, tokens } = access(env, gh === undefined ? {} : { gh })
    const result = await read
    expect(result).toEqual({ source, account: { state: 'found', login: 'ana' } })
    expect(tokens).toEqual([TOKEN])
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  it('has no source and asks GitHub nothing without a token', async () => {
    const { read, tokens } = access({})
    expect(await read).toEqual({ source: null })
    expect(tokens).toEqual([])
  })

  it('tells a token GitHub refused apart from a failed read', async () => {
    const refused = access(
      { GITHUB_TOKEN: TOKEN },
      {
        user: async () => {
          throw new GitHubAuthError(401, 'Bad credentials')
        },
      },
    )
    expect(await refused.read).toEqual({ source: 'GITHUB_TOKEN', account: { state: 'refused' } })

    const offline = access(
      {},
      {
        gh: TOKEN,
        user: async () => {
          throw new GitHubRequestError('Could not reach GitHub: fetch failed')
        },
      },
    )
    expect(await offline.read).toEqual({
      source: 'gh',
      account: { state: 'failed', error: 'Could not reach GitHub: fetch failed' },
    })
  })
})
