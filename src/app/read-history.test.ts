import { describe, expect, it } from 'vitest'
import type { FindingRecord, HistoryFilter, RunRecord } from '../store/history-store.js'
import {
  feedbackStats,
  readFeedbackStats,
  readFindings,
  readReviewDetail,
  readReviews,
  reviewDetailOf,
  ruleStats,
  storedFindings,
} from './read-history.js'
import type { HistoryReader } from './read-history.js'

const SHA = 'a'.repeat(40)
const RUN: RunRecord = {
  id: 7,
  source: 'watch',
  repo: 'acme/shop',
  number: 3,
  headSha: SHA,
  startedAt: '2026-10-22T10:00:00.000Z',
  finishedAt: '2026-10-22T10:01:00.000Z',
  status: 'published',
  aiCalled: true,
  provider: 'claude',
  findings: 1,
  score: 4,
  verdict: 'comments',
  url: 'https://github.com/acme/shop/pull/3#pullrequestreview-1',
}

function finding(id: number, changes: Partial<FindingRecord> = {}): FindingRecord {
  return {
    id,
    repo: 'acme/shop',
    number: 3,
    fingerprint: `src/a.ts:t${id}`,
    file: 'src/a.ts',
    line: id,
    title: `Finding ${id}`,
    severity: 'P1',
    outdated: false,
    publishedAt: '2026-10-22T10:01:00.000Z',
    signals: [],
    ...changes,
  }
}

const signal = (kind: FindingRecord['signals'][number]['kind'], clearedAt?: string) => ({
  kind,
  source: 'watch' as const,
  observedAt: '2026-10-22T11:00:00.000Z',
  ...(clearedAt === undefined ? {} : { clearedAt }),
})

function fakeHistory(runs: RunRecord[], findings: FindingRecord[] = []): HistoryReader {
  return {
    runs: (filter: HistoryFilter) => {
      const matching = runs.filter(
        (run) =>
          (filter.repo === undefined || run.repo === filter.repo) &&
          (filter.number === undefined || run.number === filter.number) &&
          (filter.since === undefined || run.startedAt >= filter.since),
      )
      return {
        runs: matching.slice(0, filter.limit).map(({ resultJson: _json, ...run }) => run),
        total: matching.length,
      }
    },
    findings: (filter) =>
      findings.filter(
        (record) =>
          (filter.repo === undefined || record.repo === filter.repo) &&
          (filter.number === undefined || record.number === filter.number),
      ),
    run: (id) => runs.find((run) => run.id === id),
  }
}

const REVIEW_JSON = JSON.stringify({
  schemaVersion: 1,
  status: 'reviewed',
  verdict: 'comments',
  pullRequest: {
    repo: 'acme/shop',
    number: 3,
    url: 'https://github.com/acme/shop/pull/3',
    title: 'Add the cart',
    headSha: SHA,
    state: 'open',
    draft: false,
  },
  review: {
    score: { value: 4, reason: 'One P1.' },
    summary: 'Adds the cart.',
    findings: [
      {
        severity: 'P1',
        confidence: 90,
        file: 'src/a.ts',
        line: 1,
        title: 'Finding 1',
        why: 'Because.',
        fix: 'Do this.',
        rule: 'cents',
        sources: ['rule:cents'],
        reason: null,
        suggestion: null,
        skill: 'phada',
      },
    ],
    worthChecking: [],
  },
  publication: {
    status: 'published',
    url: RUN.url,
    comments: 1,
    stillOpen: 0,
    dismissed: 0,
  },
  ci: { state: 'passing', failing: [], pending: [], checks: [{ name: 'test', state: 'passing' }] },
})

describe('readReviews', () => {
  it('reads nothing when there is no history file', () => {
    expect(readReviews(undefined, {})).toEqual({ runs: [], total: 0 })
  })

  it('reads the runs of the filter with the total', () => {
    const other = { ...RUN, id: 8, repo: 'acme/api' }
    const history = fakeHistory([RUN, { ...RUN, id: 9 }, other])

    const read = readReviews(history, { repo: 'acme/shop', limit: 1 })

    expect(read.total).toBe(2)
    expect(read.runs).toEqual([RUN])
  })
})

describe('readFindings', () => {
  it('gives each finding its destination and the marks still on it', () => {
    const history = fakeHistory(
      [],
      [
        finding(1, { signals: [signal('fixed'), signal('human-reply')] }),
        finding(2, { signals: [signal('dismissed', '2026-10-22T12:00:00.000Z')] }),
      ],
    )

    const read = readFindings(history, { repo: 'acme/shop', number: 3 })

    expect(read.map(({ id, destination, marks }) => ({ id, destination, marks }))).toEqual([
      { id: 1, destination: 'fixed', marks: ['fixed', 'human-reply'] },
      { id: 2, destination: 'open', marks: [] },
    ])
  })

  it('reads none for a pull request without runs or without a history', () => {
    expect(readFindings(fakeHistory([RUN]), { repo: 'acme/shop', number: 99 })).toEqual([])
    expect(readFindings(undefined, { repo: 'acme/shop', number: 3 })).toEqual([])
  })
})

describe('feedback stats', () => {
  const findings = [
    finding(1, { rule: 'cents', signals: [signal('fixed')] }),
    finding(2, { rule: 'cents', signals: [signal('dismissed'), signal('negative-reaction')] }),
    finding(3, { signals: [signal('human-reply')] }),
    finding(4, { repo: 'acme/api', rule: 'cents' }),
  ]

  it('counts the destinations and marks per repository', () => {
    expect(feedbackStats(findings)).toEqual([
      {
        repo: 'acme/api',
        published: 1,
        fixed: 0,
        dismissed: 0,
        ignored: 0,
        open: 1,
        negativeReaction: 0,
        humanReply: 0,
      },
      {
        repo: 'acme/shop',
        published: 3,
        fixed: 1,
        dismissed: 1,
        ignored: 0,
        open: 1,
        negativeReaction: 1,
        humanReply: 1,
      },
    ])
  })

  it('counts them per rule of each repository, leaving out findings without a rule', () => {
    expect(ruleStats(findings)).toEqual([
      {
        repo: 'acme/api',
        rule: 'cents',
        published: 1,
        fixed: 0,
        dismissed: 0,
        ignored: 0,
        open: 1,
        negativeReaction: 0,
        humanReply: 0,
      },
      {
        repo: 'acme/shop',
        rule: 'cents',
        published: 2,
        fixed: 1,
        dismissed: 1,
        ignored: 0,
        open: 0,
        negativeReaction: 1,
        humanReply: 0,
      },
    ])
  })

  it('reads both from the history, and none without one', () => {
    const read = readFeedbackStats(fakeHistory([], findings), { repo: 'acme/shop' })

    expect(read.repos.map(({ repo }) => repo)).toEqual(['acme/shop'])
    expect(read.rules.map(({ rule, published }) => [rule, published])).toEqual([['cents', 2]])
    expect(readFeedbackStats(undefined, {})).toEqual({ repos: [], rules: [] })
  })
})

describe('readReviewDetail', () => {
  it('reads the score, verdict, summary, findings, publication and feedback of a run', () => {
    const history = fakeHistory(
      [{ ...RUN, resultJson: REVIEW_JSON }],
      [
        finding(1, { runId: 7, rule: 'cents', signals: [signal('fixed')] }),
        finding(2, { runId: 6 }),
      ],
    )

    const detail = readReviewDetail(history, 7)

    expect(detail).toMatchObject({
      run: RUN,
      pullRequest: { url: 'https://github.com/acme/shop/pull/3', title: 'Add the cart' },
      verdict: 'comments',
      score: { value: 4, reason: 'One P1.' },
      summary: 'Adds the cart.',
      findings: [
        {
          severity: 'P1',
          confidence: 90,
          file: 'src/a.ts',
          line: 1,
          title: 'Finding 1',
          why: 'Because.',
          fix: 'Do this.',
          rule: 'cents',
          skill: 'phada',
          sources: ['rule:cents'],
          scope: 'change',
        },
      ],
      worthChecking: [],
      publication: {
        status: 'published',
        url: RUN.url,
        comments: 1,
        wouldResolve: null,
        reason: null,
      },
      ci: {
        state: 'passing',
        failing: [],
        pending: [],
        checks: [{ name: 'test', state: 'passing' }],
      },
    })
    expect(detail?.run).not.toHaveProperty('resultJson')
    expect(detail?.published.map(({ id, destination }) => [id, destination])).toEqual([
      [1, 'fixed'],
    ])
  })

  it('reads the failing checks of a run skipped for failing CI', () => {
    const skipped: RunRecord = {
      ...RUN,
      status: 'skipped',
      aiCalled: false,
      verdict: 'skipped',
      reason: 'ci-failing',
      score: undefined,
      findings: undefined,
      url: undefined,
      resultJson: JSON.stringify({
        ci: {
          state: 'failing',
          failing: ['test'],
          pending: [],
          checks: [{ name: 'test', state: 'failing' }],
        },
      }),
    }

    const detail = readReviewDetail(fakeHistory([skipped]), 7)

    expect(detail).toMatchObject({
      pullRequest: { url: 'https://github.com/acme/shop/pull/3', title: null },
      verdict: 'skipped',
      score: null,
      summary: null,
      findings: [],
      publication: null,
      ci: { state: 'failing', failing: ['test'], checks: [{ name: 'test', state: 'failing' }] },
      published: [],
    })
  })

  it('reads a local run with the title of its branch and no pull request link', () => {
    const local: RunRecord = {
      ...RUN,
      source: 'local',
      number: 0,
      status: 'not-published',
      url: undefined,
      branch: 'feat/spend',
      resultJson: JSON.stringify({
        local: { repo: 'acme/shop', branch: 'feat/spend', title: 'Spend crystals' },
        review: { summary: 'Adds spending.' },
      }),
    }

    expect(readReviewDetail(fakeHistory([local]), 7)).toMatchObject({
      pullRequest: { url: null, title: 'Spend crystals' },
      summary: 'Adds spending.',
      publication: null,
    })
  })

  it('reads a run without a stored result or with one it cannot read', () => {
    const failed: RunRecord = {
      ...RUN,
      status: 'failed',
      verdict: 'failed',
      error: 'timeout',
      score: undefined,
      findings: undefined,
    }

    expect(readReviewDetail(fakeHistory([failed]), 7)).toMatchObject({
      run: failed,
      score: null,
      summary: null,
      findings: [],
      publication: null,
      ci: null,
    })
    expect(
      readReviewDetail(fakeHistory([{ ...failed, resultJson: '{not json' }]), 7)?.findings,
    ).toEqual([])
  })

  it('reads what a dry run would post, resolve and skip, and why a publication was skipped', () => {
    const dryRun = JSON.stringify({
      publication: {
        status: 'dry-run',
        body: 'Phada review',
        comments: [
          { path: 'src/a.ts', line: 1, body: 'one' },
          { path: 'src/a.ts', line: 2, body: 'two' },
        ],
        stillOpen: 0,
        dismissed: 0,
        wouldSkip: { reason: 'open-threads', openThreads: 2 },
        wouldResolve: [{ id: 1, verdict: 'fixed', reason: 'gone' }],
      },
    })
    const skipped = JSON.stringify({
      publication: { status: 'skipped', reason: 'already-reviewed', openThreads: 0 },
    })

    expect(readReviewDetail(fakeHistory([{ ...RUN, resultJson: dryRun }]), 7)?.publication).toEqual(
      { status: 'dry-run', url: null, comments: 2, wouldResolve: 1, reason: 'open-threads' },
    )
    expect(
      readReviewDetail(fakeHistory([{ ...RUN, resultJson: skipped }]), 7)?.publication,
    ).toEqual({
      status: 'skipped',
      url: null,
      comments: null,
      wouldResolve: null,
      reason: 'already-reviewed',
    })
  })

  it('builds the detail of a run that is not in the history from its record and stored JSON', () => {
    const detail = reviewDetailOf({ ...RUN, resultJson: REVIEW_JSON }, [])

    expect(detail).toMatchObject({
      run: RUN,
      pullRequest: { title: 'Add the cart' },
      score: { value: 4, reason: 'One P1.' },
      findings: [{ title: 'Finding 1', why: 'Because.' }],
      published: [],
    })
    expect(detail.run).not.toHaveProperty('resultJson')
  })

  it('reads the claims of the description a stored review checked', () => {
    const stored = JSON.parse(REVIEW_JSON) as { review: Record<string, unknown> }
    const withClaims = JSON.stringify({
      ...stored,
      review: {
        ...stored.review,
        claims: [
          { claim: 'Prevents two runs', verdict: 'contradicted', evidence: 'ci.yml:4' },
          { claim: 'Covers the cart', verdict: 'unverified' },
          { verdict: 'confirmed', evidence: 'x' },
          'not a claim',
        ],
      },
    })

    expect(reviewDetailOf({ ...RUN, resultJson: withClaims }, []).claims).toEqual([
      { claim: 'Prevents two runs', verdict: 'contradicted', evidence: 'ci.yml:4' },
      { claim: 'Covers the cart', verdict: 'unverified', evidence: null },
    ])
    expect(reviewDetailOf({ ...RUN, resultJson: REVIEW_JSON }, []).claims).toEqual([])
  })

  it('reads the scope of each finding and the repository debt of a stored review', () => {
    const stored = JSON.parse(REVIEW_JSON) as {
      review: { findings: Record<string, unknown>[] } & Record<string, unknown>
    }
    const [finding] = stored.review.findings
    const withDebt = JSON.stringify({
      ...stored,
      review: {
        ...stored.review,
        findings: [{ ...finding, scope: 'repository' }],
        debt: [{ ...finding, line: 9, title: 'Old helper', scope: 'repository' }, 'not a finding'],
      },
    })

    const detail = reviewDetailOf({ ...RUN, resultJson: withDebt }, [])

    expect(detail.findings.map(({ scope }) => scope)).toEqual(['repository'])
    expect(detail.debt).toMatchObject([{ line: 9, title: 'Old helper', scope: 'repository' }])
    const older = reviewDetailOf({ ...RUN, resultJson: REVIEW_JSON }, [])
    expect(older.findings.map(({ scope }) => scope)).toEqual(['change'])
    expect(older.debt).toEqual([])
  })

  it('reads which findings of a stored review were close to the cut', () => {
    const stored = JSON.parse(REVIEW_JSON) as {
      review: { findings: Record<string, unknown>[] } & Record<string, unknown>
    }
    const [finding] = stored.review.findings
    const marked = JSON.stringify({
      ...stored,
      review: {
        ...stored.review,
        findings: [
          { ...finding, closeToCut: true },
          { ...finding, line: 2, closeToCut: 'yes' },
        ],
      },
    })

    const detail = reviewDetailOf({ ...RUN, resultJson: marked }, [])

    expect(detail.findings.map(({ closeToCut }) => closeToCut)).toEqual([true, false])
    const older = reviewDetailOf({ ...RUN, resultJson: REVIEW_JSON }, [])
    expect(older.findings.map(({ closeToCut }) => closeToCut)).toEqual([false])
  })

  it('reads the tokens of each AI pass of a stored review and their total', () => {
    const stored = JSON.parse(REVIEW_JSON) as Record<string, unknown>
    const withUsage = JSON.stringify({
      ...stored,
      usage: {
        passes: [
          {
            pass: 'review',
            skill: 'code-review',
            usage: { inputTokens: 900, cachedInputTokens: 600, outputTokens: 40 },
          },
          { pass: 'verify', skill: null, usage: null },
          { pass: 'recheck', skill: null, usage: { inputTokens: 'many' } },
          'not a pass',
        ],
        total: { inputTokens: 900, cachedInputTokens: null, outputTokens: 40 },
      },
    })

    expect(reviewDetailOf({ ...RUN, resultJson: withUsage }, []).usage).toEqual({
      passes: [
        {
          pass: 'review',
          skill: 'code-review',
          group: null,
          tokens: { input: 900, cached: 600, output: 40 },
        },
        { pass: 'verify', skill: null, group: null, tokens: null },
        { pass: 'recheck', skill: null, group: null, tokens: null },
      ],
      total: { input: 900, cached: null, output: 40 },
    })
  })

  it('reads the diff groups of a stored review and the group of each pass', () => {
    const stored = JSON.parse(REVIEW_JSON) as { review: Record<string, unknown> }
    const group = (link: string, failed: boolean) => ({
      label: 'api',
      files: ['api/a.ts'],
      bytes: 21_000,
      link,
      findings: 1,
      durationMs: 10,
      usage: null,
      failed,
    })
    const grouped = JSON.stringify({
      ...stored,
      review: {
        ...stored.review,
        groups: [
          group('directory', false),
          group('directory', true),
          group('single', false),
          'not a group',
        ],
      },
      usage: { passes: [{ pass: 'review', skill: null, group: 'api', usage: null }], total: null },
    })

    const detail = reviewDetailOf({ ...RUN, resultJson: grouped }, [])

    expect(detail.groups).toEqual({ directory: 2, single: 1, failed: 1 })
    expect(detail.usage?.passes).toEqual([
      { pass: 'review', skill: null, group: 'api', tokens: null },
    ])
    expect(reviewDetailOf({ ...RUN, resultJson: REVIEW_JSON }, []).groups).toBeNull()
  })

  it('reads the total tokens of a review stored before the passes were kept', () => {
    const stored = JSON.parse(REVIEW_JSON) as { review: Record<string, unknown> }
    const older = JSON.stringify({
      ...stored,
      review: { ...stored.review, usage: { inputTokens: 3512, outputTokens: 420 } },
    })

    expect(reviewDetailOf({ ...RUN, resultJson: older }, []).usage).toEqual({
      passes: [],
      total: { input: 3512, cached: null, output: 420 },
    })
    expect(reviewDetailOf({ ...RUN, resultJson: REVIEW_JSON }, []).usage).toBeNull()
  })

  it('reads the coverage of a stored review with its gaps counted by kind', () => {
    const stored = JSON.parse(REVIEW_JSON) as { review: Record<string, unknown> }
    const gap = (path: string, kind: string) => ({ path, kind, reason: null })
    const covered = JSON.stringify({
      ...stored,
      review: {
        ...stored.review,
        coverage: {
          level: 'low',
          covered: 2,
          total: 9,
          declaredOnly: 1,
          skipped: 1,
          gaps: [
            gap('src/a.ts', 'missing'),
            gap('src/b.ts', 'missing'),
            gap('src/c.ts', 'not-compared'),
            gap('src/d.ts', 'skipped'),
            gap('src/e.ts', 'declared-only'),
          ],
          verified: false,
          reason: '2 of 9 files reviewed.',
          continuation: null,
        },
      },
    })

    expect(reviewDetailOf({ ...RUN, resultJson: covered }, []).coverage).toEqual({
      level: 'low',
      covered: 2,
      total: 9,
      verified: false,
      gaps: { missing: 2, notCompared: 1, skipped: 1 },
    })
  })

  it('reads no coverage from a review stored before it was measured or with one it cannot read', () => {
    const stored = JSON.parse(REVIEW_JSON) as { review: Record<string, unknown> }
    const broken = JSON.stringify({
      ...stored,
      review: { ...stored.review, coverage: { level: 'most', covered: 'all' } },
    })

    expect(reviewDetailOf({ ...RUN, resultJson: REVIEW_JSON }, []).coverage).toBeNull()
    expect(reviewDetailOf({ ...RUN, resultJson: broken }, []).coverage).toBeNull()
  })

  it('reads nothing for an unknown run or without a history', () => {
    expect(readReviewDetail(fakeHistory([RUN]), 99)).toBeUndefined()
    expect(readReviewDetail(undefined, 7)).toBeUndefined()
  })
})

describe('storedFindings', () => {
  const stored = { file: 'src/a.ts', title: 'off by one', severity: 'P1', line: 3 }

  it('keeps a stored suggestion with its four fields only', () => {
    const suggestion = { startLine: 3, endLine: 4, original: 'a', replacement: 'b' }

    const [finding] = storedFindings([{ ...stored, suggestion: { ...suggestion, extra: true } }])

    expect(finding?.suggestion).toEqual(suggestion)
  })

  it.each([
    ['null', null],
    ['missing a field', { startLine: 3, endLine: 4, original: 'a' }],
    ['a field of the wrong type', { startLine: '3', endLine: 4, original: 'a', replacement: 'b' }],
    ['not an object', 'replace a with b'],
  ])('leaves out a suggestion that is %s', (_case, suggestion) => {
    const [finding] = storedFindings([{ ...stored, suggestion }])

    expect(finding).toBeDefined()
    expect(finding).not.toHaveProperty('suggestion')
  })
})
