import { describe, expect, it } from 'vitest'
import type { DeclaredRepository } from '../config/merge-config.js'
import type { RepositoryInfo } from '../github/repository.js'
import {
  MAX_RELATED,
  MAX_RELATED_CANDIDATES,
  rankRelated,
  selectCandidates,
} from './select-related.js'

const declared = (repo: string): DeclaredRepository => ({ repo, origin: '.phada/config.yml' })
const info = (repo: string, fields: Partial<RepositoryInfo> = {}): RepositoryInfo => ({
  repo,
  private: false,
  defaultBranch: 'main',
  archived: false,
  empty: false,
  ...fields,
})
const options = { reviewed: 'acme/shop', pullRequestPrivate: false, privateOnPublic: false }

describe('selectCandidates', () => {
  it('blocks a private repository for a public pull request unless the user allows it', () => {
    const infos = new Map([['acme/secret', info('acme/secret', { private: true })]])
    const list = [declared('acme/secret')]

    expect(selectCandidates(list, infos, options)).toEqual({
      candidates: [],
      skipped: [{ repo: 'acme/secret', origin: '.phada/config.yml', reason: 'private-on-public' }],
    })
    expect(
      selectCandidates(list, infos, { ...options, privateOnPublic: true }).candidates,
    ).toHaveLength(1)
    expect(
      selectCandidates(list, infos, { ...options, pullRequestPrivate: true }).candidates,
    ).toHaveLength(1)
  })

  it('skips the reviewed repository, a repository it cannot read and an empty one; keeps an archived one', () => {
    const infos = new Map<string, RepositoryInfo | 'no-access'>([
      ['acme/gone', 'no-access'],
      ['acme/empty', info('acme/empty', { empty: true })],
      ['acme/old', info('acme/old', { archived: true })],
    ])
    const list = ['Acme/Shop', 'acme/gone', 'acme/empty', 'acme/old'].map(declared)

    const { candidates, skipped } = selectCandidates(list, infos, options)

    expect(candidates.map((item) => item.declared.repo)).toEqual(['acme/old'])
    expect(skipped.map((item) => `${item.repo} ${item.reason}`)).toEqual([
      'Acme/Shop reviewed-repository',
      'acme/gone no-access',
      'acme/empty empty',
    ])
  })

  it('fetches at most 20 and skips the rest for the limit', () => {
    const names = Array.from({ length: MAX_RELATED_CANDIDATES + 2 }, (_, index) => `acme/r${index}`)
    const infos = new Map(names.map((name) => [name, info(name)]))

    const { candidates, skipped } = selectCandidates(names.map(declared), infos, options)

    expect(candidates).toHaveLength(20)
    expect(skipped.map((item) => `${item.repo} ${item.reason}`)).toEqual([
      'acme/r20 limit',
      'acme/r21 limit',
    ])
  })
})

describe('rankRelated', () => {
  it('keeps 7: related to the change first, then linked, then the rest, in declared order', () => {
    const states = [
      'unlinked',
      'linked',
      'consumers',
      'unlinked',
      'uses',
      'linked',
      'unlinked',
      'consumers',
      'unlinked',
    ] as const
    const items = states.map((state, order) => ({ state, order, name: `r${order}` }))

    const { kept, dropped } = rankRelated(items)

    expect(kept.map((item) => item.name)).toEqual(['r2', 'r4', 'r7', 'r1', 'r5', 'r0', 'r3'])
    expect(dropped.map((item) => item.name)).toEqual(['r6', 'r8'])
    expect(MAX_RELATED).toBe(7)
  })
})
