import { describe, expect, it } from 'vitest'
import { GhFacadeError } from '../gh-facade/types.js'
import { replayReads } from './replay-reads.js'

describe('replayReads', () => {
  const reads: string[] = []
  const read = replayReads(
    async (path) => {
      reads.push(path)
      return { path }
    },
    { repo: 'acme/shop' },
  )

  it.each([
    ['repos/acme/shop/issues/12/comments'],
    ['repos/acme/shop/pulls/12/reviews'],
    ['repos/acme/shop/pulls/12'],
    ['repos/acme/shop/issues/comments/99'],
    [`repos/acme/shop/commits/${'a'.repeat(40)}/check-runs`],
    [`repos/acme/shop/commits/${'a'.repeat(40)}/status`],
    [`repos/acme/shop/compare/${'a'.repeat(7)}...feature`],
    ['repos/acme/shop/commits', { sha: 'feature' }],
    ['repos/acme/shop/branches/feature'],
    ['repos/acme/shop/contents/src/a.ts', { ref: 'main' }],
    ['repos/acme/shop/pulls', { state: 'all' }],
    ['repos/acme/shop/pulls/120/files'],
    ['repos/acme/shop'],
    ['/repos/Acme/Shop/git/refs/heads/feature'],
    ['search/issues', { q: 'fee is:pr repo:acme/shop' }],
  ] as [string, Record<string, string>?][])(
    'refuses %s, which can show what came after the replayed commit',
    async (path, query) => {
      await expect(read(path, query)).rejects.toThrow(GhFacadeError)
      expect(reads).not.toContain(path)
    },
  )

  it.each(['repos/acme/shopping/contents/src/a.ts', 'repos/other/lib/pulls/3'])(
    'reads %s of another repository as usual',
    async (path) => {
      expect(await read(path)).toEqual({ path })
    },
  )
})
