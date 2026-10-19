import { describe, expect, it } from 'vitest'
import { createFakeFetch } from '../../test/support/fake-fetch.js'
import type { FakeResponse } from '../../test/support/fake-fetch.js'
import { ComparisonNotFoundError, fetchComparison } from './compare-commits.js'
import { ACCEPT_JSON } from './request.js'

const BASE = '0'.repeat(40)
const HEAD = 'f'.repeat(40)

function compare(answers: FakeResponse[]) {
  const fake = createFakeFetch({ [ACCEPT_JSON]: answers })
  const result = fetchComparison({
    owner: 'acme',
    repo: 'shop',
    token: 'ghp_SECRET',
    base: BASE,
    head: HEAD,
    fetch: fake.fetch,
  })
  return { result, calls: fake.calls }
}

describe('fetchComparison', () => {
  it('reads the files that changed between two commits with their patch', async () => {
    const body = JSON.stringify({
      files: [
        { filename: 'src/shop.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
        { filename: 'src/new.ts', previous_filename: 'src/old.ts', status: 'renamed' },
      ],
    })
    const { result, calls } = compare([{ status: 200, body }])

    expect(await result).toEqual([
      { path: 'src/shop.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
      { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed' },
    ])
    expect(calls[0]?.url).toBe(`https://api.github.com/repos/acme/shop/compare/${BASE}...${HEAD}`)
  })

  it('throws ComparisonNotFoundError when a commit is gone', async () => {
    const { result } = compare([{ status: 404, body: '{"message":"Not Found"}' }])

    await expect(result).rejects.toBeInstanceOf(ComparisonNotFoundError)
  })
})
