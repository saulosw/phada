import { describe, expect, it } from 'vitest'
import type {
  ClassifiedReply,
  FindingRecord,
  LessonRecord,
  MissRecord,
  MissReplayRecord,
} from '../store/history-store.js'
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

function openMiss(id: number, repo: string): MissRecord {
  return {
    id,
    key: `T${id}`,
    origin: 'person',
    seen: 'missed-live',
    repo,
    number: 3,
    reviewedSha: 'a'.repeat(40),
    commitSha: 'a'.repeat(40),
    threadId: `T${id}`,
    threadUrl: '',
    file: 'src/a.ts',
    line: 4,
    author: 'alice',
    role: 'member',
    body: 'Missed.',
    createdAt: '2026-10-22T10:00:00.000Z',
    harvestedAt: '2026-10-22T11:00:00.000Z',
    state: 'open',
  }
}

function readers(
  findings: FindingRecord[] | undefined,
  observed: Record<string, ObservedRead> = {},
  misses: { open: MissRecord[]; replays: MissReplayRecord[] } = { open: [], replays: [] },
  lessons: LessonRecord[] = [],
  replies: ClassifiedReply[] = [],
): LearningsReaders {
  return {
    history:
      findings === undefined
        ? undefined
        : {
            findings: () => findings,
            replies: () => replies,
            misses: (filter) => {
              expect(filter).toEqual({ state: 'open' })
              return { misses: misses.open, total: misses.open.length }
            },
            missReplays: (ids) => misses.replays.filter(({ missId }) => ids.includes(missId)),
            lessons: (filter) =>
              lessons.filter(
                ({ repo, state }) =>
                  (filter.repo === undefined || filter.repo === repo) &&
                  (filter.states === undefined || filter.states.includes(state)),
              ),
          },
    observedRepos: async () => Object.keys(observed),
    readObserved: async (repo) => observed[repo] ?? { state: 'unreadable' },
    lessonFile: (repo) => `/cfg/repos/${repo}/config.yml`,
  }
}

describe('readLearnings', () => {
  it('has nothing to show without a history or observed relations', async () => {
    expect(await readLearnings(readers(undefined))).toEqual({ recorded: false, repos: [] })
  })

  it('shows the feedback of each repository and of each rule, without relations', async () => {
    const learnings = await readLearnings(
      readers(
        [
          finding(1, { rule: 'money', signals: [signal('fixed')] }),
          finding(2, {
            rule: 'money',
            threadId: 'PRRT_2',
            signals: [signal('dismissed'), signal('human-reply')],
          }),
          finding(3, { signals: [signal('negative-reaction')] }),
          finding(4, { repo: 'acme/api', rule: 'auth' }),
        ],
        {},
        undefined,
        [],
        [
          {
            repo: 'acme/shop',
            number: 3,
            threadId: 'PRRT_2',
            commentId: 'c1',
            author: 'ana',
            kind: 'refuted',
            answered: true,
            resolved: true,
            source: 'watch',
            observedAt: '2026-10-22T12:00:00.000Z',
          },
        ],
      ),
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
      replies: { ack: 0, applied: 0, question: 0, disagreed: 0, refuted: 1 },
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
        replies: { ack: 0, applied: 0, question: 0, disagreed: 0, refuted: 1 },
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
      misses: null,
      lessons: [],
      lessonFile: '/cfg/repos/acme/web/config.yml',
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
      lessonFile: () => '/cfg/repos/acme/shop/config.yml',
    })
    expect(learnings.repos[0]?.observed).toEqual({ state: 'unreadable' })
  })

  it('counts the open misses of each repository and how many the latest replayed version caught', async () => {
    const replay = (missId: number, version: string, outcome: 'caught' | 'missed', at: string) => ({
      missId,
      version,
      outcome,
      replayedAt: at,
    })
    const learnings = await readLearnings(
      readers(
        [finding(1)],
        {},
        {
          open: [openMiss(1, 'acme/shop'), openMiss(2, 'acme/shop'), openMiss(3, 'acme/api')],
          replays: [
            replay(1, '0.11.1', 'caught', '2026-10-30T10:00:00.000Z'),
            replay(2, '0.11.1', 'caught', '2026-10-30T10:00:00.000Z'),
            replay(1, '0.12.0', 'caught', '2026-11-02T10:00:00.000Z'),
            replay(2, '0.12.0', 'missed', '2026-11-02T10:00:00.000Z'),
          ],
        },
      ),
    )

    const [api, shop] = learnings.repos
    expect(api).toMatchObject({ repo: 'acme/api', feedback: null, misses: { open: 1 } })
    expect(api?.misses?.latest).toBeUndefined()
    expect(shop?.misses).toEqual({
      open: 2,
      latest: { version: '0.12.0', caught: 1, replayed: 2 },
    })
  })

  it('lists the pending lessons of each repository, the ones more misses or comments back first', async () => {
    const lesson = (
      id: number,
      repo: string,
      state: LessonRecord['state'],
      missIds: number[],
      findingIds: number[] = [],
    ): LessonRecord => ({
      id,
      repo,
      kind: findingIds.length === 0 ? 'check' : 'avoid',
      rule: `Rule ${id}.`,
      scope: ['src/**'],
      state,
      createdAt: '2026-11-03T10:00:00.000Z',
      misses: missIds.map((missId) => openMiss(missId, repo)),
      findings: findingIds.map((findingId) => {
        const { signals: _signals, ...row } = finding(findingId, { repo })
        return row
      }),
    })
    const learnings = await readLearnings(
      readers([finding(1)], {}, { open: [], replays: [] }, [
        lesson(1, 'acme/shop', 'pending', [1]),
        lesson(2, 'acme/shop', 'pending', [2, 3]),
        lesson(3, 'acme/shop', 'accepted', [4, 5, 6]),
        lesson(4, 'acme/api', 'discarded', [7]),
        lesson(5, 'acme/web', 'pending', [8]),
        lesson(6, 'acme/shop', 'pending', [], [9, 10, 11]),
        lesson(7, 'acme/shop', 'pending', [], [12]),
      ]),
    )

    expect(learnings.repos.map(({ repo, lessons }) => [repo, lessons.map(({ id }) => id)])).toEqual(
      [
        ['acme/shop', [6, 2, 7, 1]],
        ['acme/web', [5]],
      ],
    )
  })
})
