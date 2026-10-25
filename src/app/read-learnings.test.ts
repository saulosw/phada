import { describe, expect, it } from 'vitest'
import type { FindingRecord } from '../store/history-store.js'
import type { ObservedEdge } from '../store/observed-store.js'
import { readLearnings } from './read-learnings.js'
import type { LearningsReaders, ObservedRead } from './read-learnings.js'

function finding(id: number, changes: Partial<FindingRecord> = {}): FindingRecord {
  return {
    id,
    repo: 'acme/shop',
    number: 3,
    fingerprint: `src/a.ts:t${id}`,
    file: 'src/a.ts',
    title: `Finding ${id}`,
    outdated: false,
    publishedAt: '2026-10-22T10:01:00.000Z',
    signals: [],
    ...changes,
  }
}

const signal = (kind: FindingRecord['signals'][number]['kind']) => ({
  kind,
  source: 'watch' as const,
  observedAt: '2026-10-22T11:00:00.000Z',
})

function edge(id: number, createdAt: string): ObservedEdge {
  return {
    id,
    from: { path: 'src/cart.ts', kind: 'function', name: 'total' },
    to: { path: 'src/tax.ts' },
    pullRequest: 40 + id,
    commit: 'c'.repeat(40),
    createdAt,
  }
}

function readers(
  findings: FindingRecord[] | undefined,
  observed: Record<string, ObservedRead> = {},
): LearningsReaders {
  return {
    history: findings === undefined ? undefined : { findings: () => findings },
    observedRepos: async () => Object.keys(observed),
    readObserved: async (repo) => observed[repo] ?? { state: 'unreadable' },
  }
}

describe('readLearnings', () => {
  it('has nothing to show without a history or observed relations', async () => {
    expect(await readLearnings(readers(undefined))).toEqual({ recorded: false, repos: [] })
  })

  it('shows the feedback of each repository and of each rule, without relations', async () => {
    const learnings = await readLearnings(
      readers([
        finding(1, { rule: 'money', signals: [signal('fixed')] }),
        finding(2, { rule: 'money', signals: [signal('dismissed'), signal('human-reply')] }),
        finding(3, { signals: [signal('negative-reaction')] }),
        finding(4, { repo: 'acme/api', rule: 'auth' }),
      ]),
    )
    expect(learnings.recorded).toBe(true)
    expect(learnings.repos.map(({ repo }) => repo)).toEqual(['acme/api', 'acme/shop'])
    const shop = learnings.repos[1]
    expect(shop?.observed).toEqual({ state: 'none' })
    expect(shop?.feedback).toEqual({
      repo: 'acme/shop',
      published: 3,
      fixed: 1,
      dismissed: 1,
      ignored: 0,
      open: 1,
      negativeReaction: 1,
      humanReply: 1,
    })
    expect(shop?.rules).toEqual([
      {
        repo: 'acme/shop',
        rule: 'money',
        published: 2,
        fixed: 1,
        dismissed: 1,
        ignored: 0,
        open: 0,
        negativeReaction: 0,
        humanReply: 1,
      },
    ])
    expect(learnings.repos[0]?.rules.map(({ rule }) => rule)).toEqual(['auth'])
  })

  it('joins the observed relations of each repository, newest first, with its feedback', async () => {
    const learnings = await readLearnings(
      readers([finding(1, { repo: 'acme/shop' })], {
        'acme/shop': {
          state: 'read',
          edges: [edge(1, '2026-10-20T10:00:00.000Z'), edge(2, '2026-10-24T10:00:00.000Z')],
        },
        'acme/web': { state: 'unreadable' },
      }),
    )
    expect(learnings.repos.map(({ repo }) => repo)).toEqual(['acme/shop', 'acme/web'])
    const [shop, web] = learnings.repos
    expect(shop?.observed).toEqual({
      state: 'read',
      edges: [edge(2, '2026-10-24T10:00:00.000Z'), edge(1, '2026-10-20T10:00:00.000Z')],
    })
    expect(shop?.feedback?.published).toBe(1)
    expect(web).toEqual({
      repo: 'acme/web',
      observed: { state: 'unreadable' },
      feedback: null,
      rules: [],
    })
  })

  it('matches the observed file of a repository whatever the case of its name in the history', async () => {
    const learnings = await readLearnings(
      readers([finding(1, { repo: 'Acme/Shop' })], { 'acme/shop': { state: 'read', edges: [] } }),
    )
    expect(learnings.repos).toHaveLength(1)
    expect(learnings.repos[0]?.repo).toBe('Acme/Shop')
    expect(learnings.repos[0]?.observed).toEqual({ state: 'read', edges: [] })
  })

  it('treats an observed file that fails to read as unreadable', async () => {
    const learnings = await readLearnings({
      history: undefined,
      observedRepos: async () => ['acme/shop'],
      readObserved: async () => {
        throw new Error('disk I/O error')
      },
    })
    expect(learnings.repos[0]?.observed).toEqual({ state: 'unreadable' })
  })
})
