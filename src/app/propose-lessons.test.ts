import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ReviewPrompt, ReviewProvider } from '../providers/types.js'
import type { Miss } from '../publish/misses.js'
import { InvalidLessonsAnswerError } from '../review/errors.js'
import { openHistoryStore } from '../store/history-store.js'
import type { HistoryStore } from '../store/history-store.js'
import { proposeLessons } from './propose-lessons.js'
import type { ProposeLessonsDeps, RepositoryLessons } from './propose-lessons.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-propose-lessons-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let files = 0

const T1 = '2026-11-01T10:00:00.000Z'
const NOW = '2026-11-04T10:00:00.000Z'

function miss(threadId: string, overrides: Partial<Miss> = {}): Miss {
  return {
    key: threadId,
    origin: 'person',
    seen: 'missed-live',
    repo: 'acme/shop',
    number: 3,
    commitSha: 'c'.repeat(40),
    threadId,
    threadUrl: `https://github.com/acme/shop/pull/3#${threadId}`,
    file: 'src/api/orders.ts',
    line: 20,
    author: 'alice',
    role: 'member',
    body: `Comment ${threadId}.`,
    createdAt: '2026-10-20T10:00:00Z',
    ...overrides,
  }
}

type Answer = (prompt: ReviewPrompt) => unknown

function harness(history: HistoryStore, answers: Record<string, Answer>) {
  const prompts: Record<string, ReviewPrompt> = {}
  const started: string[] = []
  const done: RepositoryLessons[] = []
  const deps: ProposeLessonsDeps = {
    history,
    setup: async (repo) => {
      const provider: ReviewProvider = {
        id: 'fake',
        review: async (prompt) => {
          prompts[repo] = prompt
          const answer = answers[repo]
          if (answer === undefined) throw new Error(`unexpected call for ${repo}`)
          const value = answer(prompt)
          return {
            text: typeof value === 'string' ? value : JSON.stringify(value),
            durationMs: 1,
            model: 'fake-model',
          }
        },
      }
      return { provider, rules: [{ key: 'no-console', scope: ['src/**'], text: 'No console.' }] }
    },
    now: () => NOW,
    events: {
      proposing: (repo) => started.push(repo),
      proposed: (result) => done.push(result),
    },
  }
  return { deps, prompts, started, done }
}

async function withHistory(test: (history: HistoryStore) => Promise<void>): Promise<void> {
  const history = await openHistoryStore(join(dir, `h${++files}`, 'history.sqlite'))
  try {
    await test(history)
  } finally {
    history.close()
  }
}

function idsByThread(history: HistoryStore): Record<string, number> {
  return Object.fromEntries(history.misses({}).misses.map(({ threadId, id }) => [threadId, id]))
}

function sentIds(prompt: ReviewPrompt | undefined): number[] {
  return [...(prompt?.data ?? '').matchAll(/\{"id":(\d+),"pr"/g)].map((match) => Number(match[1]))
}

describe('proposeLessons', () => {
  it('sends only the open misses of team people and records the lessons they show', () =>
    withHistory(async (history) => {
      history.recordMisses(
        [
          miss('owner', { role: 'owner' }),
          miss('member', { role: 'member', file: 'src/api/users.ts' }),
          miss('collaborator', { role: 'collaborator' }),
          miss('contributor', { role: 'contributor' }),
          miss('external', { role: 'external' }),
          miss('bot', { origin: 'bot', role: undefined, author: 'ci[bot]' }),
          miss('member-bot', { origin: 'bot', role: 'member', author: 'acme-reviewer' }),
          miss('phada', { origin: 'phada', role: undefined, threadId: undefined }),
          miss('dismissed', { role: 'member' }),
        ],
        T1,
      )
      const ids = idsByThread(history)
      history.dismissMiss(ids.dismissed ?? 0)
      const { deps, prompts, done } = harness(history, {
        'acme/shop': () => ({
          lessons: [
            {
              rule: 'Validate request bodies at the edge.',
              scope: ['src/api/**'],
              misses: [ids.owner, ids.member],
              extends: null,
            },
          ],
        }),
      })

      const result = await proposeLessons({}, deps)

      expect(sentIds(prompts['acme/shop']).sort()).toEqual(
        [ids.owner, ids.member, ids.collaborator].sort(),
      )
      expect(result).toEqual([{ repo: 'acme/shop', sent: 3, created: 1, attached: 0 }])
      expect(done).toEqual(result)
      expect(history.lessons({})).toMatchObject([
        {
          repo: 'acme/shop',
          rule: 'Validate request bodies at the edge.',
          scope: ['src/api/**'],
          state: 'pending',
          provider: 'fake',
          model: 'fake-model',
          createdAt: NOW,
          misses: [{ id: ids.owner }, { id: ids.member }],
        },
      ])
    }))

  it('never calls the AI when no miss is left to learn from', () =>
    withHistory(async (history) => {
      history.recordMisses([miss('bot', { origin: 'bot', role: undefined })], T1)
      const { deps, started } = harness(history, {})

      expect(await proposeLessons({}, deps)).toEqual([])
      expect(await proposeLessons({ repo: 'acme/shop' }, deps)).toEqual([
        { repo: 'acme/shop', sent: 0, created: 0, attached: 0 },
      ])
      expect(started).toEqual([])
    }))

  it('sends a miss once: later passes get only the misses no lesson holds, and the pending lessons', () =>
    withHistory(async (history) => {
      history.recordMisses([miss('A'), miss('B')], T1)
      const first = idsByThread(history)
      const { deps, prompts } = harness(history, {
        'acme/shop': (prompt) =>
          prompt.data.includes('Comment C.')
            ? {
                lessons: [
                  {
                    rule: '',
                    scope: [],
                    misses: [lessonMiss(history, 'C')],
                    extends: lessonId(history),
                  },
                ],
              }
            : {
                lessons: [{ rule: 'Rule A.', scope: ['src/**'], misses: [first.A], extends: null }],
              },
      })
      await proposeLessons({ repo: 'acme/shop' }, deps)
      history.recordMisses([miss('C')], T1)

      const result = await proposeLessons({ repo: 'acme/shop' }, deps)

      const ids = idsByThread(history)
      expect(sentIds(prompts['acme/shop']).sort()).toEqual([ids.B, ids.C].sort())
      expect(prompts['acme/shop']?.data).toContain('"rule":"Rule A."')
      expect(result).toEqual([{ repo: 'acme/shop', sent: 2, created: 0, attached: 1 }])
      expect(history.lessons({})).toMatchObject([
        { rule: 'Rule A.', misses: [{ id: ids.A }, { id: ids.C }] },
      ])
    }))

  it('keeps only valid lessons: known misses, a short rule and globs that match their files', () =>
    withHistory(async (history) => {
      history.recordMisses(
        [
          miss('api', { file: 'src/api/orders.ts' }),
          miss('db', { file: 'src/db/pool.ts' }),
          miss('root', { file: 'Makefile' }),
        ],
        T1,
      )
      const ids = idsByThread(history)
      const many = Array.from({ length: 12 }, (_, index) => `src/api/{orders,part${index}}.ts`)
      const { deps } = harness(history, {
        'acme/shop': () => ({
          lessons: [
            { rule: 'Unknown misses only.', scope: ['src/**'], misses: [999], extends: null },
            { rule: 'x'.repeat(1001), scope: ['src/**'], misses: [ids.api], extends: null },
            {
              rule: 'Fix the globs.',
              scope: ['lib/**', 'src/db/**', 'src/db/**', 'docs/**'],
              misses: [ids.api, ids.db, 999],
              extends: null,
            },
            { rule: 'Root file.', scope: ['build/**'], misses: [ids.root], extends: null },
            {
              rule: 'Too many globs.',
              scope: many,
              misses: [ids.api],
              extends: null,
            },
            { rule: 'Unknown pending.', scope: ['src/**'], misses: [ids.db], extends: 77 },
            { rule: '', scope: [], misses: [ids.db], extends: 78 },
          ],
        }),
      })

      const [result] = await proposeLessons({}, deps)

      expect(result).toEqual({ repo: 'acme/shop', sent: 3, created: 4, attached: 0 })
      const recorded = history.lessons({})
      expect(recorded.map(({ rule, scope }) => [rule, scope])).toEqual([
        ['Fix the globs.', ['src/api/**', 'src/db/**']],
        ['Root file.', ['Makefile']],
        ['Too many globs.', many.slice(0, 10)],
        ['Unknown pending.', ['src/**']],
      ])
      expect(recorded[0]?.misses.map(({ id }) => id)).toEqual([ids.api, ids.db])
    }))

  it('records nothing when the AI answer is not valid', () =>
    withHistory(async (history) => {
      history.recordMisses([miss('A')], T1)
      const { deps } = harness(history, { 'acme/shop': () => 'I could not decide.' })

      await expect(proposeLessons({}, deps)).rejects.toBeInstanceOf(InvalidLessonsAnswerError)
      expect(history.lessons({})).toEqual([])
      expect(history.linkedMissIds().size).toBe(0)
    }))

  it('sends the 50 most recent misses of a repository, one call per repository', () =>
    withHistory(async (history) => {
      history.recordMisses(
        [
          ...Array.from({ length: 55 }, (_, index) =>
            miss(`S${index}`, {
              createdAt: new Date(Date.UTC(2026, 9, 1) + index * 3_600_000).toISOString(),
            }),
          ),
          miss('api', { repo: 'acme/api' }),
        ],
        T1,
      )
      const { deps, started, prompts } = harness(history, {
        'acme/shop': () => ({ lessons: [] }),
        'acme/api': () => ({ lessons: [] }),
      })

      const result = await proposeLessons({}, deps)

      const ids = idsByThread(history)
      const sent = sentIds(prompts['acme/shop'])
      expect(sent).toContain(ids.S5)
      expect(sent).toContain(ids.S54)
      expect(sent).not.toContain(ids.S4)

      expect(started).toEqual(['acme/api', 'acme/shop'])
      expect(result.map(({ repo, sent }) => [repo, sent])).toEqual([
        ['acme/api', 1],
        ['acme/shop', 50],
      ])
    }))
})

function lessonMiss(history: HistoryStore, threadId: string): number {
  return idsByThread(history)[threadId] ?? 0
}

function lessonId(history: HistoryStore): number {
  return history.lessons({})[0]?.id ?? 0
}
