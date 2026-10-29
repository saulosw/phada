import { cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  FeedbackFinding,
  HistoryFilter,
  ListedRun,
  ReviewDetail,
} from '../../app/read-history.js'
import {
  frameLines,
  KEYS,
  minutesFrom,
  NOW,
  renderApp,
  shows,
  visibleWidth,
  waitFor,
} from '../../../test/support/tui.js'
import type { TerminalSize } from '../terminal-size.js'
import { SCREENS } from '../screens.js'
import { ReviewsScreen } from './reviews.js'

afterEach(() => cleanup())

const at = (minutes: number) => minutesFrom(NOW, minutes)
const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0'

function run(id: number, changes: Partial<ListedRun> = {}): ListedRun {
  return {
    id,
    source: 'watch',
    repo: 'acme/shop',
    number: id,
    headSha: SHA,
    startedAt: at(-id * 10 - 3),
    finishedAt: at(-id * 10),
    status: 'published',
    aiCalled: true,
    provider: 'claude',
    model: 'opus',
    score: 3,
    findings: 2,
    verdict: 'comments',
    title: `Change number ${id}`,
    ...changes,
  }
}

const RUNS: ListedRun[] = [
  run(1, { title: 'Fix the cart total', verdict: 'blocking', score: 2, requestSource: 'slack' }),
  run(2, { repo: 'acme/api', title: 'Add rate limits', verdict: 'clean', score: 5, findings: 0 }),
  run(3, {
    repo: 'acme/web',
    status: 'failed',
    verdict: 'failed',
    score: undefined,
    findings: undefined,
    source: 'manual',
    title: undefined,
    error: 'The AI CLI is not logged in',
  }),
]

function published(changes: Partial<FeedbackFinding>): FeedbackFinding {
  return {
    id: 1,
    repo: 'acme/shop',
    number: 1,
    fingerprint: 'f',
    file: 'src/cart.ts',
    line: 12,
    title: 'Total ignores the discount',
    severity: 'P0',
    runId: 1,
    outdated: false,
    publishedAt: at(-10),
    signals: [],
    destination: 'open',
    marks: [],
    ...changes,
  }
}

function detail(): ReviewDetail {
  const { title: _title, ...stored } = RUNS[0] ?? run(1)
  return {
    run: stored,
    pullRequest: { url: 'https://github.com/acme/shop/pull/1', title: 'Fix the cart total' },
    verdict: 'blocking',
    score: { value: 2, reason: 'A P0 bug in the cart total.' },
    summary: 'The cart total drops the discount when a coupon and a gift card are used together.',
    claims: [],
    findings: [
      {
        severity: 'P0',
        confidence: 90,
        file: 'src/cart.ts',
        line: 12,
        title: 'Total ignores the discount',
        why: null,
        fix: null,
        rule: null,
        skill: null,
        sources: [],
        scope: 'change',
      },
      {
        severity: 'P1',
        confidence: 80,
        file: 'src/coupon.ts',
        line: null,
        title: 'Coupon code is not trimmed',
        why: null,
        fix: null,
        rule: null,
        skill: null,
        sources: [],
        scope: 'change',
      },
    ],
    debt: [],
    worthChecking: [
      {
        severity: 'P2',
        confidence: 60,
        file: 'src/gift.ts',
        line: 3,
        title: 'Gift card rounding',
        why: null,
        fix: null,
        rule: null,
        skill: null,
        sources: [],
        scope: 'change',
      },
    ],
    publication: {
      status: 'published',
      url: 'https://github.com/acme/shop/pull/1#pullrequestreview-77',
      comments: 2,
      wouldResolve: null,
      reason: null,
    },
    ci: { state: 'failing', failing: ['lint'], pending: ['e2e'], checks: [] },
    published: [
      published({ destination: 'fixed', marks: ['fixed'] }),
      published({
        id: 2,
        file: 'src/coupon.ts',
        line: undefined,
        title: 'Coupon code is not trimmed',
        severity: 'P1',
        destination: 'dismissed',
        marks: ['dismissed', 'negative-reaction', 'human-reply'],
      }),
    ],
  }
}

function openReviews(
  options: {
    runs?: () => ListedRun[]
    total?: number
    detail?: (id: number) => ReviewDetail | undefined
    size?: TerminalSize
    language?: string
  } = {},
) {
  const filters: HistoryFilter[] = []
  const app = renderApp({
    deps: {
      readReviews: async (filter) => {
        filters.push(filter)
        const all = (options.runs ?? (() => RUNS))()
        const text = filter.text?.toLowerCase()
        const runs =
          text === undefined
            ? all
            : all.filter((item) =>
                `${item.repo}#${item.number} ${item.title ?? ''}`.toLowerCase().includes(text),
              )
        return { runs, total: options.total ?? runs.length }
      },
      readReviewDetail: async (id) => (options.detail ?? (() => detail()))(id),
      ...(options.language === undefined ? {} : { language: options.language }),
    },
    size: options.size ?? { columns: 80, rows: 24 },
    screens: [{ id: 'reviews', title: (m) => m.screens.reviews, Screen: ReviewsScreen }],
  })
  return { ...app, filters }
}

function expectFits(frame: string, size: TerminalSize) {
  const lines = frameLines(frame)
  expect(lines).toHaveLength(size.rows)
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(size.columns)
}

describe('the Reviews screen', () => {
  it('is the Reviews tab of the app', () => {
    expect(SCREENS.find(({ id }) => id === 'reviews')?.Screen).toBe(ReviewsScreen)
  })

  it('says how to get a first review when the history is empty', async () => {
    const { frame, showing } = openReviews({ runs: () => [] })
    await showing('No reviews yet.')
    expect(frame()).toContain('No reviews yet.')
    expect(frame()).not.toContain('0 reviews')
    expect(frame()).toContain('phada review owner/repo#N')
    expect(frame()).toContain('phada watch')
  })

  it('lists each review with its pull request, verdict, score, findings, when and source in 80×24', async () => {
    const { frame, showing, filters } = openReviews()
    await showing('3 reviews', 'acme/web#3', 'Enter open')
    expectFits(frame(), { columns: 80, rows: 24 })
    expect(filters[0]).toEqual({ limit: 200 })
    const rows = frameLines(frame())
    const row = (ref: string) => rows.find((line) => line.includes(ref)) ?? ''
    expect(frame()).toContain('3 reviews')
    expect(row('acme/shop#1')).toMatch(
      /❯ acme\/shop#1\s+Fix the cart total\s+blocking\s+2\/5\s+2\s+13m ago\s+Slack/,
    )
    expect(row('acme/api#2')).toMatch(
      /acme\/api#2\s+Add rate limits\s+clean\s+5\/5\s+0\s+23m ago\s+watch/,
    )
    expect(row('acme/web#3')).toMatch(/acme\/web#3\s+failed\s+–\s+–\s+33m ago\s+review/)
  })

  it('keeps the repository name and number of a long reference at 80 columns', async () => {
    const { frame, showing } = openReviews({
      runs: () => [run(5, { repo: 'some-organization/phada-dev-web', title: 'Weekly ranking' })],
    })
    await showing('Weekly ranking')
    expect(frame()).toMatch(/❯ …[\w/-]*phada-dev-web#5\s+Weekly ranking/)
  })

  it('filters by text with f, typing the shell keys into the field, and Esc leaves it unapplied', async () => {
    const { frame, press, type, showing, filters, exits } = openReviews()
    await showing('3 reviews', 'f filter')
    await press('f')
    await showing('Enter apply')
    await type('q?')
    await showing('Filter: q?')
    expect(frame()).toContain('Filter: q?')
    expect(exits).toEqual([])
    await press(KEYS.escape)
    await showing('f filter')
    expect(frame()).not.toContain('Filter:')
    expect(frame()).toContain('acme/api#2')
    await press('f')
    await showing('Enter apply')
    await type('cart')
    await press(KEYS.enter)
    await waitFor(
      () => shows(frame(), 'Filter: cart', 'f filter') && !frame().includes('acme/api#2'),
    )
    expect(filters.at(-1)).toEqual({ text: 'cart', limit: 200 })
    expect(frame()).toContain('Filter: cart')
    expect(frame()).toContain('acme/shop#1')
    expect(frame()).not.toContain('acme/api#2')
    await press('f')
    await showing('Enter apply')
    await type('zzz')
    await press(KEYS.enter)
    await showing('No review matches “cartzzz”.')
    expect(frame()).toContain('No review matches “cartzzz”.')
    await press('f')
    await showing('Enter apply')
    await press(KEYS.backspace, KEYS.backspace, KEYS.backspace, KEYS.backspace, KEYS.backspace)
    await press(KEYS.backspace, KEYS.backspace, KEYS.enter)
    await showing('acme/api#2')
    expect(filters.at(-1)).toEqual({ limit: 200 })
    expect(frame()).toContain('acme/api#2')
  })

  it('opens the detail with score, verdict, summary, findings, publication, CI, feedback and the link, and Esc goes back', async () => {
    const { frame, press, showing, exits } = openReviews({ size: { columns: 80, rows: 40 } })
    await showing('Enter open')
    await press(KEYS.enter)
    await showing('Score', 'Feedback on the published comments (2)', 'Esc back')
    const text = frame()
    expectFits(text, { columns: 80, rows: 40 })
    expect(text).toContain('acme/shop#1 · Fix the cart total')
    expect(text).toContain('https://github.com/acme/shop/pull/1')
    expect(text).toMatch(/Score\s+2\/5 — A P0 bug in the cart total\./)
    expect(text).toMatch(/Verdict\s+blocking/)
    expect(text).toMatch(/Reviewed\s+\S+ \S+ \(13m ago\) · claude opus · Slack · a1b2c3d/)
    expect(text).toMatch(/CI\s+failing · failing: lint · pending: e2e/)
    expect(text).toMatch(
      /Published\s+2 comments · https:\/\/github.com\/acme\/shop\/pull\/1#pullrequestreview-77/,
    )
    expect(text).toContain('The cart total drops the discount when a coupon and a gift card are')
    expect(text).toContain('Findings (2)')
    expect(text).toMatch(/P0\s+src\/cart.ts:12\s+Total ignores the discount/)
    expect(text).toMatch(/P1\s+src\/coupon.ts\s+Coupon code is not trimmed/)
    expect(text).toContain('Worth checking (1)')
    expect(text).toMatch(/P2\s+src\/gift.ts:3\s+Gift card rounding/)
    expect(text).toContain('Feedback on the published comments (2)')
    expect(text).toMatch(/fixed\s+src\/cart.ts:12\s+Total ignores the discount/)
    expect(text).toMatch(
      /dismissed\s+src\/coupon.ts\s+Coupon code is not trimmed · negative reaction · h/,
    )
    await press(KEYS.escape)
    await showing('3 reviews')
    expect(frame()).toContain('3 reviews')
    expect(exits).toEqual([])
  })

  it('says what a dry run would post, resolve and skip, and the body of each finding', async () => {
    const base = detail()
    const { frame, press, showing } = openReviews({
      size: { columns: 80, rows: 40 },
      detail: () => ({
        ...base,
        run: { ...base.run, status: 'dry-run', url: undefined },
        findings: base.findings.map((finding, index) =>
          index === 0
            ? { ...finding, why: 'The discount is applied after the\u0007 total.' }
            : finding,
        ),
        publication: {
          status: 'dry-run',
          url: null,
          comments: 2,
          wouldResolve: 1,
          reason: 'open-threads',
        },
        published: [],
      }),
    })
    await showing('Enter open')
    await press(KEYS.enter)
    await showing('Score', 'Esc back')
    const text = frame()
    expect(text).toMatch(
      /Published\s+nothing was posted · 2 comments · would resolve 1 · would skip:\s+already\s+reviewed, threads still open/,
    )
    expect(text).toMatch(
      /P0\s+src\/cart.ts:12\s+Total ignores the discount\n\s+The discount is applied after the total\./,
    )
    expect(text).not.toContain('\u0007')
    expectFits(text, { columns: 80, rows: 40 })
  })

  it('shows the claims of the description with their verdict and evidence in 80×24', async () => {
    const { frame, press, showing } = openReviews({
      detail: () => ({
        ...detail(),
        claims: [
          {
            claim: 'Keeps the discount with a gift card\u0007',
            verdict: 'contradicted',
            evidence: 'src/cart.ts:12 applies the gift card first',
          },
          { claim: 'Covers every coupon', verdict: 'unverified', evidence: null },
        ],
      }),
    })
    await showing('Enter open')
    await press(KEYS.enter)
    await showing('Claims of the description (2)')
    const text = frame()
    expectFits(text, { columns: 80, rows: 24 })
    expect(text).toMatch(/contradicted\s+Keeps the discount with a gift card\n/)
    expect(text).toMatch(/\s+src\/cart.ts:12 applies the gift card first/)
    expect(text).toMatch(/unverified\s+Covers every coupon/)
    expect(text).not.toContain('\u0007')
  })

  it('marks the findings of the repository and lists the repository debt in 80×24', async () => {
    const base = detail()
    const [first] = base.findings
    if (first === undefined) throw new Error('fixture without findings')
    const { frame, press, showing } = openReviews({
      detail: () => ({
        ...base,
        findings: [{ ...first, scope: 'repository' }],
        debt: [
          {
            ...first,
            file: 'src/legacy.ts',
            line: 4,
            title: 'Old total helper nobody calls\u0007',
            scope: 'repository',
          },
        ],
      }),
    })
    await showing('Enter open')
    await press(KEYS.enter)
    await showing('Repository debt (1)')
    const text = frame()
    expectFits(text, { columns: 80, rows: 24 })
    expect(text).toMatch(/P0\s+src\/cart.ts:12\s+Total ignores the discount · debt\n/)
    expect(text).toMatch(/P0\s+src\/legacy.ts:4\s+Old total helper nobody calls\n/)
    expect(text).not.toContain('\u0007')
  })

  it('names the repository debt in the language of the app', async () => {
    const base = detail()
    const [first] = base.findings
    if (first === undefined) throw new Error('fixture without findings')
    const { press, showing } = openReviews({
      language: 'pt-BR',
      detail: () => ({ ...base, debt: [{ ...first, scope: 'repository' }] }),
    })
    await showing('Enter')
    await press(KEYS.enter)
    await showing('Débito do repositório (1)')
  })

  it('names the claims in the language of the app', async () => {
    const { frame, press, showing } = openReviews({
      language: 'pt-BR',
      detail: () => ({
        ...detail(),
        claims: [{ claim: 'Covers every coupon', verdict: 'unverified', evidence: null }],
      }),
    })
    await showing('Enter')
    await press(KEYS.enter)
    await showing('Afirmações da descrição (1)')
    expect(frame()).toMatch(/não conferida\s+Covers every coupon/)
  })

  it('scrolls the detail in 80×24', async () => {
    const { frame, press, showing } = openReviews()
    await showing('Enter open')
    await press(KEYS.enter)
    await showing('Score', 'Esc back')
    expectFits(frame(), { columns: 80, rows: 24 })
    expect(frame()).toMatch(/1–\d+ of \d+/)
    expect(frame()).not.toContain('Feedback on the published comments')
    await press(KEYS.end)
    await showing('Feedback on the published comments (2)')
    expect(frame()).toContain('Feedback on the published comments (2)')
    expectFits(frame(), { columns: 80, rows: 24 })
  })

  it('shows the error of a failed review', async () => {
    const failed = RUNS[2] ?? run(3)
    const { frame, press, showing } = openReviews({
      detail: () => ({
        ...detail(),
        run: failed,
        pullRequest: { url: 'https://github.com/acme/web/pull/3', title: null },
        verdict: 'failed',
        score: null,
        summary: null,
        findings: [],
        worthChecking: [],
        publication: null,
        ci: null,
        published: [],
      }),
    })
    await showing('Enter open')
    await press(KEYS.end, KEYS.enter)
    await showing('Error', 'Esc back')
    expect(frame()).toContain('acme/web#3')
    expect(frame()).toMatch(/Error\s+The AI CLI is not logged in/)
    expect(frame()).not.toContain('Findings')
  })

  it('scrolls a long history within 80×24 and says when it shows only the latest', async () => {
    const many = Array.from({ length: 200 }, (_, index) => run(index + 1))
    const { frame, press, showing } = openReviews({ runs: () => many, total: 1234 })
    await showing('1,234 reviews · the latest 200', 'Enter open')
    expectFits(frame(), { columns: 80, rows: 24 })
    expect(frame()).toContain('1,234 reviews · the latest 200')
    expect(frame()).toMatch(/1–\d+ of 200/)
    await press(KEYS.end)
    await showing('❯ acme/shop#200')
    expect(frame()).toMatch(/\d+–200 of 200/)
    expect(frame()).toContain('❯ acme/shop#200')
  })

  it('reads the history again every 2 seconds and keeps the selected review', async () => {
    let runs = RUNS.slice(1)
    const { frame, press, showing, clock } = openReviews({ runs: () => runs })
    await showing('❯ acme/api#2', 'Enter open')
    await press(KEYS.down)
    await showing('❯ acme/web#3')
    expect(frame()).toContain('❯ acme/web#3')
    runs = [run(9, { repo: 'acme/new', title: 'Brand new' }), ...RUNS]
    clock.advance(2000)
    await showing('acme/new#9', '❯ acme/web#3')
    expect(frame()).toContain('acme/new#9')
    expect(frame()).toContain('❯ acme/web#3')
  })

  it('cleans control characters out of titles', async () => {
    const { frame, showing } = openReviews({
      runs: () => [run(1, { title: 'Evil\u001B[2J title\nwith a break\u202E' })],
      size: { columns: 160, rows: 40 },
    })
    await showing('Evil')
    expect(frame()).toContain('Evil[2J title with a break')
    expect(frame()).not.toContain('\u001B[2J')
  })

  it('fits a wide terminal', async () => {
    const size = { columns: 160, rows: 40 }
    const { frame, press, showing } = openReviews({ size })
    await showing('3 reviews', 'Enter open')
    expectFits(frame(), size)
    await press(KEYS.enter)
    await showing('Score', 'Feedback on the published comments (2)')
    expectFits(frame(), size)
    expect(frame()).toContain('Feedback on the published comments (2)')
  })

  it('is translated', async () => {
    const { frame, showing } = openReviews({ language: 'es' })
    await showing('3 revisiones')
    expect(frame()).toContain('3 revisiones')
    expect(frame()).toMatch(/hace 13m/)
  })
})
