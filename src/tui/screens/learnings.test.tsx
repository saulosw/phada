import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type { RepoStats, RuleStats } from '../../app/read-history.js'
import type { Learnings, RepoLearnings } from '../../app/read-learnings.js'
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
    ...changes,
  }
}

function full(): Learnings {
  return {
    recorded: true,
    repos: [
      shop(),
      { repo: 'acme/web', observed: { state: 'unreadable' }, feedback: null, rules: [] },
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
      },
    ],
  }
}

function openLearnings(
  read: () => Promise<Learnings>,
  options: { size?: TerminalSize; language?: string } = {},
) {
  return renderApp({
    deps: {
      readLearnings: read,
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
    expect(row(text, 'acme/web')).toMatch(/acme\/web\s+relations unreadable · no comments/)
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

  it('explains unreadable relations, a repository without comments and one without relations', async () => {
    const { frame, press, showing } = openLearnings(async () => full())
    await showing('acme/shop', 'Enter open')
    await press(KEYS.down, KEYS.enter)
    await showing('No comments published here yet.', 'Esc back')
    expect(frame()).toContain('No comments published here yet.')
    expect(frame()).toContain('The relations file could not be read')
    await press(KEYS.escape)
    await showing('Enter open')
    await press(KEYS.down, KEYS.enter)
    await showing('None of these comments came from a rule.', 'Esc back')
    expect(frame()).toContain('None of these comments came from a rule.')
    expect(frame()).toContain('None yet. Phada learns them from verified findings')
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
    await press(KEYS.enter)
    await showing('Por regra (2)', 'Esc voltar')
    expect(frame()).toContain('Por regra (2)')
  })
})
