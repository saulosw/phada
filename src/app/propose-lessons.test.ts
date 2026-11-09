import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ReviewPrompt, ReviewProvider } from '../providers/types.js'
import type { SignalKind } from '../publish/feedback.js'
import type { Miss } from '../publish/misses.js'
import type { ReplyKind } from '../review/types.js'
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

interface PhadaComment {
  threadId: string
  number?: number
  file?: string
  line?: number
  title?: string
  why?: string
  publishedAt?: string
  signals?: SignalKind[]
  replies?: { kind: ReplyKind; body?: string }[]
  repo?: string
}

function phadaComment(history: HistoryStore, comment: PhadaComment): void {
  const {
    threadId,
    repo = 'acme/shop',
    number = 5,
    file = 'src/config/load.ts',
    line = 8,
    title = `Finding ${threadId}`,
    why = `Why ${threadId}.`,
    publishedAt = T1,
    signals = [],
    replies = [],
  } = comment
  const commitSha = 'd'.repeat(40)
  const runId = history.addRun({
    source: 'watch',
    repo,
    number,
    headSha: commitSha,
    startedAt: publishedAt,
    finishedAt: publishedAt,
    status: 'published',
    aiCalled: true,
    resultJson: JSON.stringify({
      review: {
        findings: [
          { file, line: line + 1, title: 'Another finding', why: 'Another why.' },
          { file, line, title, why },
        ],
      },
    }),
  })
  history.recordPublished([
    {
      repo,
      number,
      commitSha,
      fingerprint: threadId,
      file,
      line,
      title,
      severity: 'P2',
      confidence: 80,
      rule: 'no-console',
      runId,
      publishedAt,
    },
  ])
  history.observeFeedback({
    repo,
    number,
    pullState: 'open',
    observedAt: publishedAt,
    source: 'refresh',
    threads: [
      {
        threadId,
        fingerprint: threadId,
        url: `https://github.com/${repo}/pull/${number}#${threadId}`,
        file,
        line,
        title,
        severity: 'P2',
        commitSha,
        outdated: false,
        destination: 'open',
        signals,
      },
    ],
  })
  history.recordReplies(
    replies.map(({ kind, body }, index) => ({
      repo,
      number,
      threadId,
      commentId: `${threadId}-reply-${index}`,
      author: 'alice',
      ...(body === undefined ? {} : { body }),
      kind,
      answered: false,
      resolved: false,
      source: 'watch',
      observedAt: publishedAt,
    })),
  )
}

function findingIdsByThread(history: HistoryStore): Record<string, number> {
  return Object.fromEntries(history.findings({}).map(({ threadId, id }) => [threadId, id]))
}

function blockLines(prompt: ReviewPrompt | undefined, name: string): Record<string, unknown>[] {
  const data = prompt?.data ?? ''
  const match = new RegExp(`<<<${name}_(\\w+)\\n([\\s\\S]*?)\\n${name}_\\1>>>`).exec(data)
  const body = match?.[2] ?? ''
  return body === '(none)' ? [] : body.split('\n').map((line) => JSON.parse(line))
}

type Answer = (prompt: ReviewPrompt) => unknown

function harness(history: HistoryStore, answers: Record<string, Answer>) {
  const prompts: Record<string, ReviewPrompt[]> = {}
  const started: string[] = []
  const done: RepositoryLessons[] = []
  const deps: ProposeLessonsDeps = {
    history,
    setup: async (repo) => {
      const provider: ReviewProvider = {
        id: 'fake',
        review: async (prompt) => {
          prompts[repo] = [...(prompts[repo] ?? []), prompt]
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
      return {
        provider,
        rules: [{ key: 'no-console', kind: 'check', scope: ['src/**'], text: 'No console.' }],
      }
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
  return blockLines(prompt, 'PHADA_MISSES').map(({ id }) => Number(id))
}

function sentFindingIds(prompt: ReviewPrompt | undefined): number[] {
  return blockLines(prompt, 'PHADA_FINDINGS').map(({ id }) => Number(id))
}

function lastPrompt(
  prompts: Record<string, ReviewPrompt[]>,
  repo: string,
): ReviewPrompt | undefined {
  return prompts[repo]?.at(-1)
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

      expect(sentIds(lastPrompt(prompts, 'acme/shop')).sort()).toEqual(
        [ids.owner, ids.member, ids.collaborator].sort(),
      )
      expect(result).toEqual([
        {
          repo: 'acme/shop',
          sent: 3,
          created: 1,
          attached: 0,
          sentFindings: 0,
          attachedFindings: 0,
        },
      ])
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
        {
          repo: 'acme/shop',
          sent: 0,
          created: 0,
          attached: 0,
          sentFindings: 0,
          attachedFindings: 0,
        },
      ])
      expect(started).toEqual([])
    }))

  it('sends a miss once as new: later passes get it as context while no lesson holds it', () =>
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
      expect(sentIds(lastPrompt(prompts, 'acme/shop')).sort()).toEqual([ids.B, ids.C].sort())
      expect(lastPrompt(prompts, 'acme/shop')?.data).toContain('"rule":"Rule A."')
      expect(result).toEqual([
        {
          repo: 'acme/shop',
          sent: 1,
          created: 0,
          attached: 1,
          sentFindings: 0,
          attachedFindings: 0,
        },
      ])
      expect(prompts['acme/shop']).toHaveLength(2)
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

      expect(result).toEqual({
        repo: 'acme/shop',
        sent: 3,
        created: 4,
        attached: 0,
        sentFindings: 0,
        attachedFindings: 0,
      })
      const recorded = history.lessons({})
      expect(recorded.map(({ rule, scope }) => [rule, scope])).toEqual([
        ['Fix the globs.', ['src/api/**', 'src/db/**']],
        ['Root file.', ['Makefile']],
        ['Too many globs.', many.slice(0, 10)],
        ['Unknown pending.', ['src/**']],
      ])
      expect(recorded[0]?.misses.map(({ id }) => id)).toEqual([ids.api, ids.db])
    }))

  it('records nothing and marks no miss sent when the AI answer is not valid', () =>
    withHistory(async (history) => {
      history.recordMisses([miss('A')], T1)
      let answer: unknown = 'I could not decide.'
      const { deps, prompts } = harness(history, { 'acme/shop': () => answer })

      await expect(proposeLessons({}, deps)).rejects.toBeInstanceOf(InvalidLessonsAnswerError)
      expect(history.lessons({})).toEqual([])
      expect(history.linkedMissIds().size).toBe(0)

      answer = { lessons: [] }

      expect(await proposeLessons({}, deps)).toEqual([
        {
          repo: 'acme/shop',
          sent: 1,
          created: 0,
          attached: 0,
          sentFindings: 0,
          attachedFindings: 0,
        },
      ])
      expect(prompts['acme/shop']).toHaveLength(2)
    }))

  it('sends up to 50 new misses a call with the 25 most recent earlier ones, at most 5 calls a repository', () =>
    withHistory(async (history) => {
      history.recordMisses(
        [
          ...Array.from({ length: 260 }, (_, index) =>
            miss(`S${index}`, {
              createdAt: new Date(Date.UTC(2026, 9, 1) + index * 3_600_000).toISOString(),
            }),
          ),
          miss('api', { repo: 'acme/api' }),
        ],
        T1,
      )
      const ids = idsByThread(history)
      const range = (from: number, to: number) =>
        Array.from({ length: from - to + 1 }, (_, index) => ids[`S${from - index}`])
      const { deps, started, prompts } = harness(history, {
        'acme/shop': () => ({ lessons: [] }),
        'acme/api': () => ({ lessons: [] }),
      })

      const result = await proposeLessons({}, deps)

      const shop = prompts['acme/shop'] ?? []
      expect(shop.map(sentIds)).toEqual([
        range(259, 210),
        [...range(209, 160), ...range(259, 235)],
        [...range(159, 110), ...range(259, 235)],
        [...range(109, 60), ...range(259, 235)],
        [...range(59, 10), ...range(259, 235)],
      ])
      expect(started).toEqual([
        'acme/api',
        'acme/shop',
        'acme/shop',
        'acme/shop',
        'acme/shop',
        'acme/shop',
      ])
      expect(result.map(({ repo, sent }) => [repo, sent])).toEqual([
        ['acme/api', 1],
        ['acme/shop', 250],
      ])

      const next = await proposeLessons({}, deps)

      expect(prompts['acme/shop']?.slice(5).map(sentIds)).toEqual([
        [...range(9, 0), ...range(259, 235)],
      ])
      expect(prompts['acme/api']).toHaveLength(1)
      expect(next).toEqual([
        {
          repo: 'acme/shop',
          sent: 10,
          created: 0,
          attached: 0,
          sentFindings: 0,
          attachedFindings: 0,
        },
      ])
      expect(await proposeLessons({}, deps)).toEqual([])
      expect(await proposeLessons({ repo: 'acme/shop' }, deps)).toEqual([
        {
          repo: 'acme/shop',
          sent: 0,
          created: 0,
          attached: 0,
          sentFindings: 0,
          attachedFindings: 0,
        },
      ])
      expect(prompts['acme/shop']).toHaveLength(6)
    }))

  it('sends the comments of Phada the team refused, with the why of the run and the replies', () =>
    withHistory(async (history) => {
      phadaComment(history, {
        threadId: 'dismissed',
        signals: ['dismissed'],
        publishedAt: '2026-10-01T10:00:00.000Z',
      })
      phadaComment(history, {
        threadId: 'thumbs-down',
        signals: ['negative-reaction'],
        publishedAt: '2026-10-02T10:00:00.000Z',
      })
      phadaComment(history, {
        threadId: 'refuted',
        replies: [
          { kind: 'ack', body: 'Thanks.' },
          { kind: 'refuted', body: 'The schema rejects null configs already.' },
        ],
        publishedAt: '2026-10-03T10:00:00.000Z',
      })
      phadaComment(history, {
        threadId: 'disagreed',
        replies: [{ kind: 'disagreed' }],
        publishedAt: '2026-10-04T10:00:00.000Z',
      })
      phadaComment(history, { threadId: 'fixed', signals: ['fixed'] })
      phadaComment(history, { threadId: 'ignored', signals: ['ignored', 'human-reply'] })
      phadaComment(history, { threadId: 'question', replies: [{ kind: 'question', body: 'Why?' }] })
      const { deps, prompts } = harness(history, { 'acme/shop': () => ({ lessons: [] }) })

      const result = await proposeLessons({}, deps)

      const ids = findingIdsByThread(history)
      const prompt = lastPrompt(prompts, 'acme/shop')
      expect(sentFindingIds(prompt)).toEqual([
        ids.disagreed,
        ids.refuted,
        ids['thumbs-down'],
        ids.dismissed,
      ])
      expect(blockLines(prompt, 'PHADA_FINDINGS')[1]).toEqual({
        id: ids.refuted,
        pr: 5,
        file: 'src/config/load.ts',
        line: 8,
        severity: 'P2',
        rule: 'no-console',
        title: 'Finding refuted',
        comment: 'Why refuted.',
        signals: [],
        replies: [
          { kind: 'ack', reply: 'Thanks.' },
          { kind: 'refuted', reply: 'The schema rejects null configs already.' },
        ],
      })
      expect(blockLines(prompt, 'PHADA_FINDINGS')[0]?.replies).toEqual([{ kind: 'disagreed' }])
      expect(blockLines(prompt, 'PHADA_FINDINGS')[3]?.signals).toEqual(['dismissed'])
      expect(sentIds(prompt)).toEqual([])
      expect(result).toEqual([
        {
          repo: 'acme/shop',
          sent: 0,
          created: 0,
          attached: 0,
          sentFindings: 4,
          attachedFindings: 0,
        },
      ])
      expect(await proposeLessons({}, deps)).toEqual([])
      expect(prompts['acme/shop']).toHaveLength(1)
    }))

  it('leaves out a comment of Phada whose signal was cleared or that no thread holds', () =>
    withHistory(async (history) => {
      phadaComment(history, { threadId: 'cleared', signals: ['dismissed'] })
      history.observeFeedback({
        repo: 'acme/shop',
        number: 5,
        pullState: 'open',
        observedAt: NOW,
        source: 'refresh',
        threads: [
          {
            threadId: 'cleared',
            fingerprint: 'cleared',
            url: '',
            file: 'src/config/load.ts',
            line: 8,
            title: 'Finding cleared',
            commitSha: 'd'.repeat(40),
            outdated: false,
            destination: 'open',
            signals: [],
          },
        ],
      })
      history.recordPublished([
        {
          repo: 'acme/shop',
          number: 6,
          commitSha: 'e'.repeat(40),
          fingerprint: 'unthreaded',
          file: 'src/a.ts',
          line: 1,
          title: 'No thread',
          severity: 'P2',
          confidence: 80,
          publishedAt: T1,
        },
      ])
      const { deps, started } = harness(history, {})

      expect(await proposeLessons({}, deps)).toEqual([])
      expect(started).toEqual([])
    }))

  it('sends the fixed comments of Phada in the files of the refused ones, at most 20, the latest first', () =>
    withHistory(async (history) => {
      phadaComment(history, { threadId: 'refused', signals: ['dismissed'] })
      for (let index = 0; index < 22; index++) {
        phadaComment(history, {
          threadId: `fixed-${index}`,
          signals: ['fixed'],
          line: 100 + index,
          publishedAt: new Date(Date.UTC(2026, 9, 1) + index * 3_600_000).toISOString(),
        })
      }
      phadaComment(history, { threadId: 'elsewhere', file: 'src/other.ts', signals: ['fixed'] })
      const { deps, prompts } = harness(history, { 'acme/shop': () => ({ lessons: [] }) })

      await proposeLessons({}, deps)

      const hits = blockLines(lastPrompt(prompts, 'acme/shop'), 'PHADA_HITS')
      expect(hits).toHaveLength(20)
      expect(hits[0]).toEqual({ file: 'src/config/load.ts', line: 121, title: 'Finding fixed-21' })
      expect(hits.at(-1)).toEqual({
        file: 'src/config/load.ts',
        line: 102,
        title: 'Finding fixed-2',
      })
    }))

  it('records an avoid lesson with the comments it comes from and marks them sent', () =>
    withHistory(async (history) => {
      history.recordMisses([miss('A')], T1)
      phadaComment(history, { threadId: 'one', signals: ['dismissed'] })
      phadaComment(history, {
        threadId: 'two',
        signals: ['negative-reaction'],
        file: 'src/config/save.ts',
      })
      const ids = findingIdsByThread(history)
      const misses = idsByThread(history)
      const { deps } = harness(history, {
        'acme/shop': () => ({
          lessons: [
            {
              kind: 'avoid',
              rule: 'Do not ask for null checks on parsed configs.',
              scope: ['lib/**'],
              misses: [misses.A],
              findings: [ids.one, ids.two],
              extends: null,
            },
          ],
        }),
      })

      const [result] = await proposeLessons({}, deps)

      expect(result).toMatchObject({ sent: 1, sentFindings: 2, created: 1 })
      expect(history.lessons({})).toMatchObject([
        {
          kind: 'avoid',
          rule: 'Do not ask for null checks on parsed configs.',
          scope: ['src/config/**'],
          misses: [],
          findings: [{ id: ids.one }, { id: ids.two }],
        },
      ])
      expect(history.findings({}).map(({ lessonsSentAt }) => lessonsSentAt)).toEqual([NOW, NOW])
      expect(history.misses({}).misses[0]?.lessonsSentAt).toBe(NOW)
    }))

  it('marks no comment of Phada sent when the AI answer is not valid', () =>
    withHistory(async (history) => {
      phadaComment(history, { threadId: 'one', signals: ['dismissed'] })
      const { deps, prompts } = harness(history, { 'acme/shop': () => 'No idea.' })

      await expect(proposeLessons({}, deps)).rejects.toBeInstanceOf(InvalidLessonsAnswerError)
      expect(history.findings({})[0]?.lessonsSentAt).toBeUndefined()
      await expect(proposeLessons({}, deps)).rejects.toBeInstanceOf(InvalidLessonsAnswerError)
      expect(prompts['acme/shop']).toHaveLength(2)
    }))

  it('sends up to 30 new comments of Phada a call with the 15 most recent earlier ones', () =>
    withHistory(async (history) => {
      for (let index = 0; index < 70; index++) {
        phadaComment(history, {
          threadId: `R${index}`,
          signals: ['dismissed'],
          publishedAt: new Date(Date.UTC(2026, 9, 1) + index * 3_600_000).toISOString(),
        })
      }
      const ids = findingIdsByThread(history)
      const range = (from: number, to: number) =>
        Array.from({ length: from - to + 1 }, (_, index) => ids[`R${from - index}`])
      const { deps, prompts } = harness(history, { 'acme/shop': () => ({ lessons: [] }) })

      const [result] = await proposeLessons({}, deps)

      expect(prompts['acme/shop']?.map(sentFindingIds)).toEqual([
        range(69, 40),
        [...range(39, 10), ...range(69, 55)],
        [...range(9, 0), ...range(69, 55)],
      ])
      expect(result?.sentFindings).toBe(70)
    }))

  it('shows the kind of the pending lessons and extends an avoid lesson with new comments of Phada', () =>
    withHistory(async (history) => {
      phadaComment(history, { threadId: 'one', signals: ['dismissed'] })
      const ids = () => findingIdsByThread(history)
      const { deps, prompts } = harness(history, {
        'acme/shop': (prompt) =>
          blockLines(prompt, 'PHADA_LESSONS').length === 0
            ? {
                lessons: [
                  {
                    kind: 'avoid',
                    rule: 'Avoid A.',
                    scope: ['src/config/**'],
                    misses: [],
                    findings: [ids().one],
                    extends: null,
                  },
                ],
              }
            : {
                lessons: [
                  {
                    kind: 'avoid',
                    rule: '',
                    scope: [],
                    misses: [],
                    findings: [ids().two],
                    extends: lessonId(history),
                  },
                ],
              },
      })
      await proposeLessons({}, deps)
      phadaComment(history, { threadId: 'two', signals: ['dismissed'] })

      const [result] = await proposeLessons({}, deps)

      expect(blockLines(lastPrompt(prompts, 'acme/shop'), 'PHADA_LESSONS')).toEqual([
        { id: lessonId(history), kind: 'avoid', rule: 'Avoid A.', scope: ['src/config/**'] },
      ])
      expect(sentFindingIds(lastPrompt(prompts, 'acme/shop'))).toEqual([ids().two])
      expect(result).toMatchObject({ sentFindings: 1, attachedFindings: 1 })
      expect(history.lessons({})[0]?.findings.map(({ id }) => id)).toEqual([ids().one, ids().two])
    }))
})

function lessonMiss(history: HistoryStore, threadId: string): number {
  return idsByThread(history)[threadId] ?? 0
}

function lessonId(history: HistoryStore): number {
  return history.lessons({})[0]?.id ?? 0
}
