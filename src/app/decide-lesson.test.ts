import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { parseConfigText } from '../config/parse-config.js'
import type { Miss } from '../publish/misses.js'
import { openHistoryStore } from '../store/history-store.js'
import type { HistoryStore } from '../store/history-store.js'
import {
  acceptLesson,
  discardLesson,
  LessonDecidedError,
  LessonNotFoundError,
  LessonRuleRefusedError,
} from './decide-lesson.js'
import type { AcceptLessonDeps } from './decide-lesson.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-decide-lesson-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let stores = 0

const T1 = '2026-11-01T10:00:00.000Z'
const NOW = '2026-11-04T10:00:00.000Z'
const PATH = '/config/repos/acme/shop/config.yml'
const HEADER = '# Your own Phada config for acme/shop.\n'

function miss(threadId: string, overrides: Partial<Miss> = {}): Miss {
  return {
    key: threadId,
    origin: 'person',
    seen: 'missed-live',
    repo: 'acme/shop',
    number: 3,
    commitSha: 'c'.repeat(40),
    threadId,
    threadUrl: `https://github.com/acme/shop/pull/3#discussion_${threadId}`,
    file: 'src/api/orders.ts',
    line: 20,
    author: 'alice',
    role: 'member',
    body: `Comment ${threadId}.`,
    createdAt: '2026-10-20T10:00:00Z',
    ...overrides,
  }
}

async function withLesson(
  misses: Miss[],
  test: (history: HistoryStore, lessonId: number) => Promise<void>,
): Promise<void> {
  const history = await openHistoryStore(join(dir, `h${++stores}`, 'history.sqlite'))
  try {
    history.recordMisses(misses, T1)
    const missIds = history.misses({}).misses.map(({ id }) => id)
    const [lessonId] = history.recordLessons(
      {
        repo: 'acme/shop',
        created: [{ rule: 'Validate request bodies at the edge.', scope: ['src/api/**'], missIds }],
        attached: [],
      },
      T1,
    )
    await test(history, lessonId ?? 0)
  } finally {
    history.close()
  }
}

function publishFinding(history: HistoryStore, threadId: string, url: string): number {
  const commitSha = 'd'.repeat(40)
  const file = 'src/config/load.ts'
  const title = `Finding ${threadId}`
  history.recordPublished([
    {
      repo: 'acme/shop',
      number: 5,
      commitSha,
      fingerprint: threadId,
      file,
      line: 8,
      title,
      severity: 'P2',
      confidence: 80,
      publishedAt: T1,
    },
  ])
  history.observeFeedback({
    repo: 'acme/shop',
    number: 5,
    pullState: 'open',
    observedAt: T1,
    source: 'refresh',
    threads: [
      {
        threadId,
        fingerprint: threadId,
        url,
        file,
        line: 8,
        title,
        severity: 'P2',
        commitSha,
        outdated: false,
        destination: 'open',
        signals: ['dismissed'],
      },
    ],
  })
  const found = history.findings({}).find((finding) => finding.fingerprint === threadId)
  return found?.id ?? 0
}

async function withAvoidLesson(
  urls: string[],
  test: (history: HistoryStore, lessonId: number) => Promise<void>,
): Promise<void> {
  const history = await openHistoryStore(join(dir, `h${++stores}`, 'history.sqlite'))
  try {
    const findingIds = urls.map((url, index) => publishFinding(history, `f${index}`, url))
    const [lessonId] = history.recordLessons(
      {
        repo: 'acme/shop',
        created: [
          {
            kind: 'avoid',
            rule: 'Do not ask for comments on config loaders.',
            scope: ['src/config/**'],
            missIds: [],
            findingIds,
          },
        ],
        attached: [],
      },
      T1,
    )
    await test(history, lessonId ?? 0)
  } finally {
    history.close()
  }
}

function acceptDeps(history: HistoryStore, initial: Record<string, string> = {}) {
  const files = memoryFiles(initial)
  const deps: AcceptLessonDeps = {
    history,
    files,
    env: { PHADA_CONFIG_HOME: '/config' },
    home: '/home/me',
    template: (repo) => `# Your own Phada config for ${repo}.\n`,
    now: () => NOW,
  }
  return { deps, files }
}

describe('acceptLesson', () => {
  it('writes the lesson as a rule of your config for its repository and marks it accepted', () =>
    withLesson([miss('r1'), miss('r2', { threadUrl: '' }), miss('r3')], async (history, id) => {
      const { deps, files } = acceptDeps(history)

      const accepted = await acceptLesson(id, deps)

      expect(accepted).toEqual({
        lessonId: id,
        repo: 'acme/shop',
        kind: 'check',
        ruleId: `lesson-${id}`,
        path: PATH,
        created: true,
      })
      expect(files.files.get(PATH)).toBe(
        [
          HEADER,
          'rules:',
          `  - id: lesson-${id}`,
          '    rule: Validate request bodies at the edge.',
          '    scope:',
          '      - src/api/**',
          '    from:',
          '      - https://github.com/acme/shop/pull/3#discussion_r1',
          '      - https://github.com/acme/shop/pull/3#discussion_r3',
          '',
        ].join('\n'),
      )
      expect(history.lessons({ id })).toEqual([
        expect.objectContaining({ state: 'accepted', decidedAt: NOW }),
      ])
    }))

  it('leaves from out when no miss of the lesson has a thread link', () =>
    withLesson([miss('r1', { threadUrl: '' })], async (history, id) => {
      const { deps, files } = acceptDeps(history, { [PATH]: 'minConfidence: 70\n' })

      const accepted = await acceptLesson(id, deps)

      expect(accepted?.created).toBe(false)
      expect(files.files.get(PATH)).toBe(
        [
          'minConfidence: 70',
          'rules:',
          `  - id: lesson-${id}`,
          '    rule: Validate request bodies at the edge.',
          '    scope:',
          '      - src/api/**',
          '',
        ].join('\n'),
      )
    }))

  it('writes an avoid lesson as an avoid rule from the threads of its Phada comments', () =>
    withAvoidLesson(
      [
        'https://github.com/acme/shop/pull/5#discussion_r1',
        '',
        'https://github.com/acme/shop/pull/5#discussion_r1',
        'https://github.com/acme/shop/pull/5#discussion_r2',
      ],
      async (history, id) => {
        const { deps, files } = acceptDeps(history)

        const accepted = await acceptLesson(id, deps)

        expect(accepted).toEqual(expect.objectContaining({ kind: 'avoid', ruleId: `lesson-${id}` }))
        const written = files.files.get(PATH) ?? ''
        expect(written).toBe(
          [
            HEADER,
            'rules:',
            `  - id: lesson-${id}`,
            '    kind: avoid',
            '    rule: Do not ask for comments on config loaders.',
            '    scope:',
            '      - src/config/**',
            '    from:',
            '      - https://github.com/acme/shop/pull/5#discussion_r1',
            '      - https://github.com/acme/shop/pull/5#discussion_r2',
            '',
          ].join('\n'),
        )
        const parsed = parseConfigText(written)
        expect(parsed.ok && parsed.config.rules).toEqual([
          {
            id: `lesson-${id}`,
            kind: 'avoid',
            rule: 'Do not ask for comments on config loaders.',
            scope: ['src/config/**'],
            from: [
              'https://github.com/acme/shop/pull/5#discussion_r1',
              'https://github.com/acme/shop/pull/5#discussion_r2',
            ],
          },
        ])
      },
    ))

  it('shows the kind of an avoid lesson in the draft and keeps it after the edit', () =>
    withAvoidLesson(['https://github.com/acme/shop/pull/5#discussion_r1'], async (history, id) => {
      const { deps, files } = acceptDeps(history)
      const drafts: string[] = []

      await acceptLesson(id, deps, async (draft) => {
        drafts.push(draft)
        return 'rule: Do not ask for comments.\nscope: [src/**]\n'
      })

      expect(drafts[0]).toMatch(/^# .*avoid rule lesson-\d+/m)
      expect(drafts[0]).toContain('# https://github.com/acme/shop/pull/5#discussion_r1\n')
      expect(drafts[0]).toContain('rule: Do not ask for comments on config loaders.\n')
      expect(files.files.get(PATH)).toContain(
        `  - id: lesson-${id}\n    kind: avoid\n    rule: Do not ask for comments.\n`,
      )
    }))

  it('refuses an unknown lesson and one already decided, writing nothing', () =>
    withLesson([miss('r1')], async (history, id) => {
      const { deps, files } = acceptDeps(history)
      history.decideLesson(id, 'discarded', T1)

      await expect(acceptLesson(999, deps)).rejects.toThrow(new LessonNotFoundError(999).message)
      await expect(acceptLesson(id, deps)).rejects.toBeInstanceOf(LessonDecidedError)
      await expect(acceptLesson(id, deps)).rejects.toThrow(`Lesson ${id} is already discarded.`)
      expect(files.files.size).toBe(0)
    }))

  it.each([
    ['the rule id is taken', (id: number) => `rules:\n  - id: lesson-${id}\n    rule: Mine.\n`],
    ['the config is invalid', () => 'rules:\n  - rule: x\n    level: high\n'],
  ])('refuses when %s, keeping the lesson pending and the file as it was', (_case, text) =>
    withLesson([miss('r1')], async (history, id) => {
      const current = text(id)
      const { deps, files } = acceptDeps(history, { [PATH]: current })

      await expect(acceptLesson(id, deps)).rejects.toBeInstanceOf(LessonRuleRefusedError)
      expect(files.files.get(PATH)).toBe(current)
      expect(history.lessons({ id })[0]?.state).toBe('pending')
    }),
  )

  it('says why it refuses', () =>
    withLesson([miss('r1')], async (history, id) => {
      const taken = acceptDeps(history, { [PATH]: `rules:\n  - id: lesson-${id}\n    rule: M.\n` })
      const invalid = acceptDeps(history, { [PATH]: 'rules:\n  - rule: x\n    level: high\n' })

      await expect(acceptLesson(id, taken.deps)).rejects.toThrow(
        `${PATH} already has a rule lesson-${id}; rename or remove it, then accept again.`,
      )
      await expect(acceptLesson(id, invalid.deps)).rejects.toThrow(
        `${PATH} is not a valid config (rules.0.level: Unrecognized key: "level"); fix it first.`,
      )
    }))
})

describe('discardLesson', () => {
  it('marks a pending lesson discarded and writes nothing', () =>
    withLesson([miss('r1')], async (history, id) => {
      discardLesson(id, { history, now: () => NOW })

      expect(history.lessons({ id })).toEqual([
        expect.objectContaining({ state: 'discarded', decidedAt: NOW }),
      ])
      expect(() => discardLesson(id, { history, now: () => NOW })).toThrow(
        `Lesson ${id} is already discarded.`,
      )
      expect(() => discardLesson(999, { history, now: () => NOW })).toThrow(LessonNotFoundError)
    }))
})
