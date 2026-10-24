import { describe, expect, it } from 'vitest'
import type { WatchedRepoSettings } from '../config/watch-settings.js'
import type { OpenPull } from '../github/list-pull-requests.js'
import { eligibility } from './filters.js'

const PULL: OpenPull = {
  number: 3,
  headSha: 'a'.repeat(40),
  draft: false,
  author: 'alice',
  authorIsBot: false,
  association: 'MEMBER',
  labels: [],
  baseRef: 'main',
  private: false,
}
const REPO: WatchedRepoSettings = { repo: 'acme/shop', publish: 'pr', allowExternal: false }

describe('eligibility', () => {
  it('accepts a ready pull request of a member', () => {
    expect(eligibility(PULL, REPO)).toEqual({ eligible: true })
  })

  it.each([
    ['a draft', { draft: true }, 'draft'],
    ['a bot', { authorIsBot: true }, 'bot'],
    ['an outside author on a public repository', { association: 'CONTRIBUTOR' }, 'external'],
    ['a first-time author on a public repository', { association: 'NONE' }, 'external'],
  ] as const)('leaves out %s', (_case, overrides, reason) => {
    expect(eligibility({ ...PULL, ...overrides }, REPO)).toEqual({ eligible: false, reason })
  })

  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])(
    'trusts %s on a public repository',
    (association) => {
      expect(eligibility({ ...PULL, association }, REPO).eligible).toBe(true)
    },
  )

  it('accepts outside authors when the repository allows them', () => {
    const pull = { ...PULL, association: 'CONTRIBUTOR' }

    expect(eligibility(pull, { ...REPO, allowExternal: true })).toEqual({ eligible: true })
  })

  it('accepts any author on a private repository', () => {
    expect(eligibility({ ...PULL, association: 'NONE', private: true }, REPO)).toEqual({
      eligible: true,
    })
  })

  it('keeps only the listed authors, ignoring case', () => {
    const repo = { ...REPO, authors: ['Alice'] }

    expect(eligibility(PULL, repo)).toEqual({ eligible: true })
    expect(eligibility({ ...PULL, author: 'bob' }, repo)).toEqual({
      eligible: false,
      reason: 'author',
    })
  })

  it('needs one of the listed labels', () => {
    const repo = { ...REPO, labels: ['phada', 'review'] }

    expect(eligibility({ ...PULL, labels: ['Review'] }, repo)).toEqual({ eligible: true })
    expect(eligibility({ ...PULL, labels: ['wip'] }, repo)).toEqual({
      eligible: false,
      reason: 'label',
    })
  })

  it('keeps only the listed base branches', () => {
    const repo = { ...REPO, baseBranches: ['main'] }

    expect(eligibility({ ...PULL, baseRef: 'dev' }, repo)).toEqual({
      eligible: false,
      reason: 'base',
    })
  })

  it('reports the first reason in order', () => {
    const pull = { ...PULL, draft: true, authorIsBot: true, baseRef: 'dev' }

    expect(eligibility(pull, { ...REPO, baseBranches: ['main'] })).toEqual({
      eligible: false,
      reason: 'draft',
    })
  })
})
