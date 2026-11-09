import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { RepoStats, RuleStats } from '../../app/read-history.js'
import type { Learnings, RepoLearnings } from '../../app/read-learnings.js'
import type { AcceptedLesson } from '../../app/decide-lesson.js'
import type { FindingRow, LessonRecord, MissRecord } from '../../store/history-store.js'
import type { ObservedEdge } from '../../store/observed-store.js'
import {
  frameLines,
  KEYS,
  minutesFrom,
  NOW,
  renderApp,
  visibleWidth,
} from '../../../test/support/tui.js'
import { SCREENS } from '../screens.js'
import type { TerminalSize } from '../terminal-size.js'
import { LearningsScreen } from './learnings.js'

afterEach(() => cleanup())

const counts = (changes: Partial<RepoStats> = {}) => ({
  published: 30,
  fixed: 10,
  dismissed: 5,
  ignored: 8,
  open: 7,
  negativeReaction: 2,
  humanReply: 3,
  replies: { ack: 0, applied: 0, question: 0, disagreed: 0, refuted: 0 },
  ...changes,
})

function rule(name: string, changes: Partial<RuleStats> = {}): RuleStats {
  return {
    repo: 'acme/shop',
    rule: name,
    ...counts({
      published: 8,
      fixed: 3,
      dismissed: 1,
      ignored: 2,
      open: 2,
      negativeReaction: 1,
      humanReply: 0,
    }),
    ...changes,
  }
}

function edge(id: number, minutesAgo: number): ObservedEdge {
  return {
    id,
    from: { path: 'src/cart/total.ts', kind: 'function', name: 'cartTotal' },
    to: { path: 'src/tax/rates.ts', kind: 'method', owner: 'Rates', name: 'forRegion' },
    pullRequest: 40 + id,
    commit: 'c'.repeat(40),
    createdAt: minutesFrom(NOW, -minutesAgo),
  }
}

function shop(changes: Partial<RepoLearnings> = {}): RepoLearnings {
  return {
    repo: 'acme/shop',
    observed: { state: 'read', edges: [edge(2, 90), edge(1, 2 * 24 * 60)] },
    feedback: { repo: 'acme/shop', ...counts() },
    rules: [
      rule('money-in-cents'),
      rule('no-console', {
        published: 1,
        fixed: 1,
        dismissed: 0,
        ignored: 0,
        open: 0,
        negativeReaction: 0,
      }),
    ],
    misses: null,
    lessons: [],
    lessonFile: '/home/ana/.config/phada/repos/acme/shop/config.yml',
    ...changes,
  }
}

function full(): Learnings {
  return {
    recorded: true,
    repos: [
      shop(),
      {
        repo: 'acme/web',
        observed: { state: 'unreadable' },
        feedback: null,
        rules: [],
        misses: { open: 3, latest: { version: '0.12.0', caught: 1, replayed: 2 } },
        lessons: [],
        lessonFile: '/home/ana/.config/phada/repos/acme/web/config.yml',
      },
      {
        repo: 'saulosw/verno',
        observed: { state: 'none' },
        feedback: {
          repo: 'saulosw/verno',
          ...counts({
            published: 4,
            fixed: 1,
            dismissed: 1,
            ignored: 1,
            open: 1,
            negativeReaction: 0,
            humanReply: 0,
          }),
        },
        rules: [],
        misses: null,
        lessons: [],
        lessonFile: '/home/ana/.config/phada/repos/saulosw/verno/config.yml',
      },
    ],
  }
}

function miss(id: number): MissRecord {
  return {
    id,
    key: `T${id}`,
    origin: 'person',
    seen: 'missed-live',
    repo: 'acme/shop',
    number: 3,
    reviewedSha: 'a'.repeat(40),
    commitSha: 'a'.repeat(40),
    threadId: `T${id}`,
    threadUrl: `https://github.com/acme/shop/pull/3#discussion_r${id}`,
    file: 'src/cart/total.ts',
    line: 4,
    author: 'alice',
    role: 'member',
    body: 'Missed.',
    createdAt: '2026-11-02T10:00:00.000Z',
    harvestedAt: '2026-11-02T11:00:00.000Z',
    state: 'open',
  }
}

const CENTS_RULE =
  'Keep every price in integer cents from the cart to the invoice: a float total drifts by a cent once taxes and discounts are applied, and the invoice no longer matches what the payment provider charged.'

function lesson(id: number, rule: string, scope: string[], misses: number): LessonRecord {
  return {
    id,
    repo: 'acme/shop',
    kind: 'check',
    rule,
    scope,
    state: 'pending',
    createdAt: '2026-11-03T10:00:00.000Z',
    misses: Array.from({ length: misses }, (_, index) => miss(id * 10 + index)),
    findings: [],
  }
}

function comment(id: number, title: string): FindingRow {
  return {
    id,
    repo: 'acme/shop',
    number: 5,
    fingerprint: `f${id}`,
    file: 'src/config/load.ts',
    line: 8 + id,
    title,
    severity: 'P2',
    threadUrl: `https://github.com/acme/shop/pull/5#discussion_r${id}`,
    outdated: false,
    publishedAt: '2026-10-21T10:00:00.000Z',
  }
}

function avoidLesson(id: number): LessonRecord {
  return {
    ...lesson(id, 'Do not ask for comments on config loaders.', ['src/config/**'], 0),
    kind: 'avoid',
    findings: [comment(1, 'Comment the loader'), comment(2, 'Document the defaults')],
  }
}

function lessonHistory(
  options: { accept?: (id: number) => Promise<AcceptedLesson>; pending?: LessonRecord[] } = {},
) {
  let pending = options.pending ?? [
    lesson(2, CENTS_RULE, ['src/cart/**', 'src/tax/**'], 2),
    lesson(1, 'Never log the payment token.', ['src/payments/**'], 1),
  ]
  const accepted: number[] = []
  const discarded: number[] = []
  const decided = (id: number) => {
    pending = pending.filter((candidate) => candidate.id !== id)
  }
  return {
    accepted,
    discarded,
    deps: {
      readLearnings: async (): Promise<Learnings> => ({
        recorded: true,
        repos: [shop({ misses: { open: 3 }, lessons: pending })],
      }),
      acceptLesson: async (id: number) => {
        accepted.push(id)
        const result = await (options.accept?.(id) ??
          Promise.resolve({
            lessonId: id,
            repo: 'acme/shop',
            kind: 'check' as const,
            ruleId: `lesson-${id}`,
            path: '/home/ana/.config/phada/repos/acme/shop/config.yml',
            created: false,
          }))
        decided(id)
        return result
      },
      discardLesson: async (id: number) => {
        discarded.push(id)
        decided(id)
      },
    },
  }
}

function openLearnings(
  read: () => Promise<Learnings>,
  options: {
    size?: TerminalSize
    language?: string
    deps?: Partial<Parameters<typeof renderApp>[0] & object>['deps']
  } = {},
) {
  return renderApp({
    deps: {
      readLearnings: read,
      ...options.deps,
      ...(options.language === undefined ? {} : { language: options.language }),
    },
    size: options.size ?? { columns: 80, rows: 24 },
    screens: [{ id: 'learnings', title: (m) => m.screens.learnings, Screen: LearningsScreen }],
  })
}

function expectFits(frame: string, size: TerminalSize) {
  const lines = frameLines(frame)
  expect(lines).toHaveLength(size.rows)
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(size.columns)
}

const flat = (frame: string) => frame.replace(/\s+/g, ' ')

const row = (frame: string, repo: string) =>
  frameLines(frame).find((line) => line.includes(repo)) ?? ''

describe('the Learnings screen', () => {
  it('is the Learnings tab of the app', () => {
    expect(SCREENS.find(({ id }) => id === 'learnings')?.Screen).toBe(LearningsScreen)
  })

  it('says how to start learning when there is no history', async () => {
    const { frame, showing } = openLearnings(async () => ({ recorded: false, repos: [] }))
    await showing('Nothing learned yet')
    expect(frame()).toContain('Nothing learned yet: Phada learns from the reviews it publishes.')
    expect(frame()).toContain('phada review owner/repo#N')
    expect(frame()).toContain('phada watch')
  })

  it('says nothing was published yet when the history has nothing to learn from', async () => {
    const { frame, showing } = openLearnings(async () => ({ recorded: true, repos: [] }))
    await showing('No published comments or relations yet.')
    expect(frame()).toContain('No published comments or relations yet.')
  })

  it('lists each repository with its relations and the feedback of its comments in 80×24', async () => {
    const { frame, showing } = openLearnings(async () => full())
    await showing('What Phada learned from its reviews', 'saulosw/verno', 'Enter open')
    const text = frame()
    expectFits(text, { columns: 80, rows: 24 })
    expect(text).toContain('What Phada learned from its reviews · 3 repositories')
    expect(row(text, 'acme/shop')).toMatch(
      /❯ acme\/shop\s+2 relations · 30 comments: 10 fixed · 5 dismissed · 8 ignored/,
    )
    expect(text).toContain('Misses: threads of people that no Phada finding came near.')
    expect(row(text, 'acme/web')).toMatch(
      /acme\/web\s+relations unreadable · 3 misses · no comments/,
    )
    expect(row(text, 'saulosw/verno')).toMatch(
      /saulosw\/verno\s+no relations · 4 comments: 1 fixed · 1 dismissed/,
    )
  })

  it('leaves out of a row the outcomes no comment had', async () => {
    const { frame, showing } = openLearnings(async () => ({
      recorded: true,
      repos: [
        shop({
          observed: { state: 'none' },
          feedback: {
            repo: 'acme/shop',
            ...counts({ published: 3, fixed: 0, dismissed: 0, ignored: 1, open: 2 }),
          },
        }),
      ],
    }))
    await showing('acme/shop')
    expect(row(frame(), 'acme/shop')).toMatch(/no relations · 3 comments: 1 ignored · 2 open\s*$/)
  })

  it('opens a repository with its feedback, each rule and the relations, and goes back with Esc', async () => {
    const { frame, press, showing, exits } = openLearnings(async () => full())
    await showing('acme/shop', 'Enter open')
    await press(KEYS.enter)
    await showing('Relations learned (2)', 'Esc back')
    const text = frame()
    expectFits(text, { columns: 80, rows: 24 })
    expect(text).toMatch(/Comments Phada published\s+30/)
    expect(text).toContain('10 fixed · 5 dismissed · 8 ignored · 7 open')
    expect(text).toContain('2 with a negative reaction · 3 with a reply from a person')
    expect(text).toContain('By rule (2)')
    expect(text).toContain('money-in-cents')
    expect(text).toContain('8 comments: 3 fixed · 1 dismissed · 2 ignored · 2 open')
    expect(text).toContain('1 with a negative reaction · 0 with a reply from a person')
    expect(text).toContain('Relations learned (2)')
    expect(text).toContain('src/cart/total.ts › cartTotal')
    expect(text).toMatch(/→ src\/tax\/rates\.ts › Rates\.forRegion · #42 · \S+ \S+ \(1h ago\)/)
    expect(frameLines(text).findIndex((line) => line.includes('#42'))).toBeLessThan(
      frameLines(text).findIndex((line) => line.includes('#41')),
    )
    await press(KEYS.escape)
    await showing('What Phada learned from its reviews')
    expect(frame()).toContain('What Phada learned from its reviews')
    expect(exits).toEqual([])
  })

  it('shows how many comments got each kind of reply, for the repository and each rule', async () => {
    const replies = { ack: 0, applied: 1, question: 2, disagreed: 0, refuted: 1 }
    const replied = shop({
      feedback: { repo: 'acme/shop', ...counts({ replies }) },
      rules: [rule('money-in-cents', { replies: { ...replies, applied: 0, question: 1 } })],
    })
    const read = async (): Promise<Learnings> => ({ recorded: true, repos: [replied] })
    for (const [language, repo, byRule] of [
      ['en', 'Replies: applied 1 · question 2 · refuted 1', 'Replies: question 1 · refuted 1'],
      [
        'pt',
        'Respostas: aplicado 1 · pergunta 2 · refutação 1',
        'Respostas: pergunta 1 · refutação 1',
      ],
      [
        'es',
        'Respuestas: aplicado 1 · pregunta 2 · refutación 1',
        'Respuestas: pregunta 1 · refutación 1',
      ],
    ] as const) {
      const { frame, press, showing } = openLearnings(read, { language })
      await showing('acme/shop')
      await press(KEYS.enter)
      await showing(repo)
      expectFits(frame(), { columns: 80, rows: 24 })
      expect(frame()).toContain(byRule)
      cleanup()
    }
  })

  it('leaves the replies out when no comment got one', async () => {
    const { frame, press, showing } = openLearnings(async () => full())
    await showing('acme/shop')
    await press(KEYS.enter)
    await showing('Relations learned (2)')
    expect(frame()).not.toContain('Replies:')
  })

  it('explains unreadable relations, a repository without comments and one without relations', async () => {
    const { frame, press, showing } = openLearnings(async () => full())
    await showing('acme/shop', 'Enter open')
    await press(KEYS.down, KEYS.enter)
    await showing('No comments published here yet.', 'Esc back')
    expect(frame()).toContain('No comments published here yet.')
    expect(frame()).toMatch(
      /Misses of Phada\s+3 open · 1 of 2 caught in 0\.12\.0\s*\n\s+Review them again with phada misses --replay/,
    )
    expect(frame()).toContain('The relations file could not be read')
    await press(KEYS.escape)
    await showing('Enter open')
    await press(KEYS.down, KEYS.enter)
    await showing('None of these comments came from a rule.', 'Esc back')
    expect(frame()).toContain('None of these comments came from a rule.')
    expect(frame()).not.toContain('Misses of Phada')
    expect(frame()).toContain('None yet. Phada learns them from verified findings')
  })

  it('says when the misses of a repository were never replayed', async () => {
    const { frame, press, showing } = openLearnings(async () => ({
      recorded: true,
      repos: [shop({ misses: { open: 1 } })],
    }))
    await showing('acme/shop', 'Enter open')
    expect(row(frame(), 'acme/shop')).toContain('2 relations · 1 miss · 30 comments')
    await press(KEYS.enter)
    await showing('Misses of Phada', 'Esc back')
    expect(frame()).toMatch(
      /Misses of Phada\s+1 open · not replayed yet\s*\n\s+Review them again with phada misses --replay/,
    )
  })

  it('scrolls a long detail within 80×24', async () => {
    const edges = Array.from({ length: 30 }, (_, index) => edge(index + 1, index + 10))
    const { frame, press, showing } = openLearnings(async () => ({
      recorded: true,
      repos: [shop({ observed: { state: 'read', edges } })],
    }))
    await showing('acme/shop', 'Enter open')
    await press(KEYS.enter)
    await showing(/1–\d+ of \d+/, 'Esc back')
    expectFits(frame(), { columns: 80, rows: 24 })
    expect(frame()).toMatch(/1–\d+ of \d+/)
    await press(KEYS.end)
    await showing('#70')
    expect(frame()).toContain('#70')
    expectFits(frame(), { columns: 80, rows: 24 })
  })

  it('reads the learnings again every 2 seconds', async () => {
    let learnings: Learnings = { recorded: false, repos: [] }
    const { frame, clock, showing } = openLearnings(async () => learnings)
    await showing('Nothing learned yet')
    expect(frame()).toContain('Nothing learned yet')
    learnings = full()
    clock.advance(2000)
    await showing('acme/shop')
    expect(frame()).toContain('acme/shop')
  })

  it('fits a wide terminal', async () => {
    const size = { columns: 160, rows: 40 }
    const { frame, press, showing } = openLearnings(async () => full(), { size })
    await showing('saulosw/verno', 'Enter open')
    expectFits(frame(), size)
    expect(row(frame(), 'acme/shop')).toContain('7 open')
    await press(KEYS.enter)
    await showing('Relations learned (2)', 'Esc back')
    expectFits(frame(), size)
  })

  it('is translated', async () => {
    const { frame, press, showing } = openLearnings(async () => full(), { language: 'pt' })
    await showing('O que o Phada aprendeu com os reviews', 'Enter abrir')
    expect(frame()).toContain('O que o Phada aprendeu com os reviews · 3 repositórios')
    expect(row(frame(), 'acme/shop')).toContain('2 relações · 30 comentários: 10 corrigidos')
    expect(row(frame(), 'acme/web')).toContain('relações ilegíveis · 3 misses · sem comentários')
    await press(KEYS.enter)
    await showing('Por regra (2)', 'Esc voltar')
    expect(frame()).toContain('Por regra (2)')
  })

  describe('lessons', () => {
    const openShop = async (history: ReturnType<typeof lessonHistory>, language?: string) => {
      const app = openLearnings(history.deps.readLearnings, {
        deps: history.deps,
        ...(language === undefined ? {} : { language }),
      })
      await app.showing('acme/shop', /Enter (open|abrir)/)
      return app
    }

    it('shows the pending lessons of a repository with their full rule, files and misses', async () => {
      const history = lessonHistory()
      const { frame, press, showing } = await openShop(history)
      expect(row(frame(), 'acme/shop')).toContain('3 misses · 2 lessons · 30 comments')
      await press(KEYS.enter)
      await showing('Lessons to decide (2)', 'l decide lessons')
      const text = frame()
      expectFits(text, { columns: 80, rows: 24 })
      expect(flat(text)).toContain(CENTS_RULE)
      expect(text).toContain('files: src/cart/**, src/tax/** · backed by 2 misses')
      expect(text).toContain('Never log the payment token.')
      expect(text).toContain('files: src/payments/** · backed by 1 miss')
      expect(text.indexOf('Keep every price')).toBeLessThan(text.indexOf('Never log'))
    })

    it('marks an avoid lesson and lists the Phada comments it comes from', async () => {
      const history = lessonHistory({
        pending: [
          avoidLesson(3),
          lesson(1, 'Never log the payment token.', ['src/payments/**'], 1),
        ],
      })
      const { frame, press, showing } = await openShop(history)
      await press(KEYS.enter)
      await showing('Lessons to decide (2)', 'l decide lessons')
      const text = frame()
      expectFits(text, { columns: 80, rows: 24 })
      expect(text).toContain('Do not ask for comments on config loaders.')
      expect(text).toContain('avoid · files: src/config/** · backed by 2 refused comments')
      expect(text).toContain('Comment the loader · src/config/load.ts:9')
      expect(text).toContain('https://github.com/acme/shop/pull/5#discussion_r1')
      expect(text).toContain('Document the defaults · src/config/load.ts:10')
      expect(text).toContain('files: src/payments/** · backed by 1 miss')
    })

    it('marks an avoid lesson in the list and says what accepting it writes, in 80×24', async () => {
      const history = lessonHistory({
        pending: [
          avoidLesson(3),
          lesson(1, 'Never log the payment token.', ['src/payments/**'], 1),
        ],
      })
      const { frame, press, showing } = await openShop(history)
      await press(KEYS.enter)
      await showing('l decide lessons')
      await press('l')
      await showing('Lessons of acme/shop to decide (2)', 'a accept')
      expectFits(frame(), { columns: 80, rows: 24 })
      expect(row(frame(), 'Do not ask for comments')).toMatch(/avoid · 2 refused\s*$/)
      expect(row(frame(), 'Never log')).toMatch(/1 miss\s*$/)
      await press('a')
      await showing('Accept lesson 3 as a rule of your config for acme/shop?', 'Enter accept')
      const text = frame()
      expectFits(text, { columns: 80, rows: 24 })
      expect(flat(text)).toContain(
        'Adds the avoid rule lesson-3 to ~/.config/phada/repos/acme/shop/config.yml; reviews stop reporting what it describes in its files:',
      )
      expect(text).toContain('files: src/config/** · from 2 threads')
    })

    it('says where lessons come from when there are misses but none was proposed', async () => {
      const { frame, press, showing } = openLearnings(async () => ({
        recorded: true,
        repos: [shop({ misses: { open: 2 } })],
      }))
      await showing('acme/shop', 'Enter open')
      await press(KEYS.enter)
      await showing('phada lessons --refresh')
      expect(frame()).toMatch(/No lessons proposed yet\..*\n?.*phada lessons --refresh/)
      expect(frame()).not.toContain('l decide lessons')
    })

    it('accepts the selected lesson after asking, and lists it no more', async () => {
      const history = lessonHistory()
      const { frame, press, showing, until } = await openShop(history)
      await press(KEYS.enter)
      await showing('l decide lessons')
      await press('l')
      await showing('Lessons of acme/shop to decide (2)', 'a accept', 'd discard')
      expectFits(frame(), { columns: 80, rows: 24 })
      await press('a')
      await showing('Accept lesson 2 as a rule of your config for acme/shop?')
      await showing('Enter accept', 'Esc cancel')
      await press(KEYS.escape)
      await until(() => !frame().includes('Accept lesson 2'), 'the question to close')
      expect(history.accepted).toEqual([])
      expect(frame()).toContain('Lessons of acme/shop to decide (2)')
      await press('a')
      await showing('Accept lesson 2 as a rule')
      await press(KEYS.enter)
      await until(
        () =>
          frame().includes('Lessons of acme/shop to decide (1)') &&
          flat(frame()).includes(
            'Added the rule lesson-2 to ~/.config/phada/repos/acme/shop/config.yml; edit it from the Rules screen.',
          ),
        'the accepted lesson to leave the list',
      )
      expect(history.accepted).toEqual([2])
      expect(frame()).not.toContain('Keep every price')
      expectFits(frame(), { columns: 80, rows: 24 })
    })

    it('shows the file, the rule id and the whole rule before accepting it in 80×24', async () => {
      const rule = `${CENTS_RULE} `.repeat(5).slice(0, 999).trimEnd() + '.'
      expect(rule.length).toBeGreaterThan(990)
      const history = lessonHistory({
        pending: [
          lesson(2, rule, ['src/cart/**', 'src/tax/**'], 2),
          lesson(1, 'Never log the payment token.', ['src/payments/**'], 1),
        ],
      })
      const { frame, press, showing, until } = await openShop(history)
      await press(KEYS.enter)
      await showing('l decide lessons')
      await press('l', 'a')
      await showing('Accept lesson 2 as a rule of your config for acme/shop?', 'Enter accept')
      const text = frame()
      expectFits(text, { columns: 80, rows: 24 })
      expect(text).toContain(
        'Adds the rule lesson-2 to ~/.config/phada/repos/acme/shop/config.yml:',
      )
      expect(flat(text)).toContain(flat(rule))
      expect(text).toContain('files: src/cart/**, src/tax/** · from 2 threads')
      expect(text).not.toContain('Never log the payment token.')
      expect(text).not.toMatch(/\d+–\d+ of \d+/)
      expect(history.accepted).toEqual([])
      await press(KEYS.enter)
      await until(() => frame().includes('to decide (1)'), 'the accepted lesson to leave the list')
      expect(history.accepted).toEqual([2])
    })

    it('discards the selected lesson after asking, and says when none is left', async () => {
      const history = lessonHistory()
      const { frame, press, showing, until } = await openShop(history)
      await press(KEYS.enter)
      await showing('l decide lessons')
      await press('l')
      await showing('Lessons of acme/shop to decide (2)')
      await press(KEYS.down, 'd')
      await showing('Discard lesson 1?', 'Enter discard', 'Esc cancel')
      await press(KEYS.escape)
      await until(() => !frame().includes('Discard lesson 1?'), 'the question to close')
      expect(history.discarded).toEqual([])
      await press('d')
      await showing('Discard lesson 1?')
      await press(KEYS.enter)
      await showing('Lessons of acme/shop to decide (1)', 'Discarded lesson 1.')
      expect(history.discarded).toEqual([1])
      expect(frame()).not.toContain('Never log the payment token.')
      await press('d', KEYS.enter)
      await showing('No lessons left to decide.', 'Discarded lesson 2.')
      expect(history.discarded).toEqual([1, 2])
      await press(KEYS.escape)
      await showing('Misses of Phada', 'Esc back')
      expect(frame()).not.toContain('Lessons to decide')
    })

    it('shows why an accept was refused and keeps the lesson', async () => {
      const history = lessonHistory({
        accept: () =>
          Promise.reject(
            new Error(
              '/home/ana/.config/phada/repos/acme/shop/config.yml already has a rule lesson-2; rename or remove it, then accept again.',
            ),
          ),
      })
      const { frame, press, showing, until, exits } = await openShop(history)
      await press(KEYS.enter)
      await showing('l decide lessons')
      await press('l', 'a')
      await showing('Accept lesson 2')
      await press(KEYS.enter)
      await until(
        () =>
          flat(frame()).includes(
            'Not accepted: /home/ana/.config/phada/repos/acme/shop/config.yml already has a rule lesson-2',
          ),
        'the refusal of the accept',
      )
      expect(history.accepted).toEqual([2])
      expect(frame()).toContain('Lessons of acme/shop to decide (2)')
      expect(exits).toEqual([])
      expectFits(frame(), { columns: 80, rows: 24 })
    })

    it('is translated', async () => {
      const history = lessonHistory()
      const { frame, press, showing } = await openShop(history, 'pt')
      expect(row(frame(), 'acme/shop')).toContain('2 lessons')
      await press(KEYS.enter)
      await showing('Lessons para decidir (2)', 'l decidir lessons')
      await press('l', 'a')
      await showing('Aceitar a lesson 2 como regra da sua config para acme/shop?')
      expect(frame()).toContain('Enter aceitar')
    })

    it.each([
      [
        'pt',
        'avoid · arquivos: src/config/** · com base em 2 comentários recusados',
        'avoid · 2 recusados',
      ],
      [
        'es',
        'avoid · archivos: src/config/** · respaldada por 2 comentarios rechazados',
        'avoid · 2 rechazados',
      ],
    ])('marks an avoid lesson in %s', async (language, meta, weight) => {
      const history = lessonHistory({ pending: [avoidLesson(3)] })
      const { frame, press, showing } = await openShop(history, language)
      await press(KEYS.enter)
      await showing(meta)
      await press('l')
      await showing(weight)
      expect(row(frame(), 'Do not ask for comments')).toContain(weight)
    })
  })
})
