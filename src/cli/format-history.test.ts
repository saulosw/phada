import { describe, expect, it } from 'vitest'
import type { FindingRecord, RunRecord } from '../store/history-store.js'
import {
  feedbackStats,
  formatHistoryJson,
  formatHistoryText,
  formatStatsJson,
  formatStatsText,
} from './format-history.js'

const local = (iso: string) => {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const STARTED = '2026-10-22T12:00:00.000Z'
const RUN: RunRecord = {
  id: 1,
  source: 'watch',
  repo: 'acme/shop',
  number: 3,
  headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  startedAt: STARTED,
  finishedAt: STARTED,
  status: 'published',
  aiCalled: true,
  provider: 'claude',
  model: 'opus',
  score: 4,
  findings: 2,
  url: 'https://github.com/acme/shop/pull/3#pullrequestreview-1',
}

const FINDING: FindingRecord = {
  id: 1,
  repo: 'acme/shop',
  number: 3,
  commitSha: 'a'.repeat(40),
  fingerprint: 'src/shop.ts:spendhasnoauth',
  file: 'src/shop.ts',
  line: 44,
  title: 'Spend has no auth',
  severity: 'P1',
  confidence: 90,
  rule: 'auth',
  threadId: 'T1',
  threadUrl: 'https://github.com/acme/shop/pull/3#discussion_r1',
  outdated: true,
  publishedAt: STARTED,
  signals: [
    { kind: 'dismissed', source: 'watch', observedAt: STARTED, clearedAt: STARTED },
    { kind: 'fixed', source: 'watch', observedAt: STARTED },
    { kind: 'negative-reaction', source: 'manual', observedAt: STARTED },
  ],
}

const finding = (overrides: Partial<FindingRecord>): FindingRecord => ({ ...FINDING, ...overrides })

describe('formatHistoryText', () => {
  it('prints one line per run', () => {
    const skipped: RunRecord = {
      ...RUN,
      id: 2,
      source: 'manual',
      status: 'skipped',
      aiCalled: false,
      reason: 'same-diff',
      score: undefined,
      findings: undefined,
      url: undefined,
      model: undefined,
    }

    expect(formatHistoryText([RUN, skipped], 2, undefined)).toBe(
      [
        `${local(STARTED)}  acme/shop#3  a1b2c3d  watch   published  claude/opus · score 4 · 2 findings · https://github.com/acme/shop/pull/3#pullrequestreview-1`,
        `${local(STARTED)}  acme/shop#3  a1b2c3d  manual  skipped    claude · same-diff`,
        '',
      ].join('\n'),
    )
  })

  it('says when more runs exist than shown', () => {
    expect(formatHistoryText([RUN], 7, undefined)).toContain(
      'Showing 1 of 7 reviews; use --limit or --since for more.',
    )
  })

  it('lists the findings of a pull request with destination and marks', () => {
    const text = formatHistoryText([RUN], 1, [
      FINDING,
      finding({ id: 2, severity: undefined, line: undefined, outdated: false, signals: [] }),
      finding({
        id: 3,
        outdated: false,
        signals: [{ kind: 'human-reply', source: 'watch', observedAt: STARTED }],
      }),
    ])

    expect(text).toContain(
      [
        'Findings:',
        '  P1  src/shop.ts:44  Spend has no auth  fixed · outdated · negative reaction',
        '  --  src/shop.ts  Spend has no auth  open',
        '  P1  src/shop.ts:44  Spend has no auth  open · replied',
      ].join('\n'),
    )
  })

  it('says the history is empty', () => {
    expect(formatHistoryText([], 0, undefined)).toBe('No reviews in the history yet.\n')
  })

  it('strips control characters from titles', () => {
    const text = formatHistoryText([], 0, [finding({ title: 'Bad\u001b[31m title‮' })])

    expect(text).not.toContain('\u001b')
    expect(text).not.toContain('‮')
  })
})

describe('formatHistoryJson', () => {
  it('prints runs, findings and the total with schemaVersion 1', () => {
    const json = JSON.parse(formatHistoryJson([RUN], 4, [FINDING])) as Record<string, unknown>

    expect(json).toEqual({
      schemaVersion: 1,
      total: 4,
      runs: [
        {
          id: 1,
          jobId: null,
          source: 'watch',
          repo: 'acme/shop',
          number: 3,
          headSha: RUN.headSha,
          startedAt: STARTED,
          finishedAt: STARTED,
          status: 'published',
          aiCalled: true,
          provider: 'claude',
          model: 'opus',
          score: 4,
          findings: 2,
          url: RUN.url,
          reason: null,
          errorKind: null,
          error: null,
        },
      ],
      findings: [
        {
          repo: 'acme/shop',
          number: 3,
          file: 'src/shop.ts',
          line: 44,
          title: 'Spend has no auth',
          severity: 'P1',
          confidence: 90,
          rule: 'auth',
          commitSha: 'a'.repeat(40),
          threadUrl: FINDING.threadUrl,
          publishedAt: STARTED,
          destination: 'fixed',
          outdated: true,
          signals: [
            { kind: 'dismissed', source: 'watch', observedAt: STARTED, clearedAt: STARTED },
            { kind: 'fixed', source: 'watch', observedAt: STARTED, clearedAt: null },
            { kind: 'negative-reaction', source: 'manual', observedAt: STARTED, clearedAt: null },
          ],
        },
      ],
    })
  })
})

describe('feedbackStats', () => {
  it('counts the current destination and marks per repository', () => {
    const stats = feedbackStats([
      FINDING,
      finding({ id: 2, signals: [] }),
      finding({ id: 3, signals: [{ kind: 'ignored', source: 'watch', observedAt: STARTED }] }),
      finding({
        id: 4,
        repo: 'acme/web',
        signals: [
          { kind: 'dismissed', source: 'watch', observedAt: STARTED },
          { kind: 'human-reply', source: 'watch', observedAt: STARTED },
        ],
      }),
    ])

    expect(stats).toEqual([
      {
        repo: 'acme/shop',
        published: 3,
        fixed: 1,
        dismissed: 0,
        ignored: 1,
        open: 1,
        negativeReaction: 1,
        humanReply: 0,
      },
      {
        repo: 'acme/web',
        published: 1,
        fixed: 0,
        dismissed: 1,
        ignored: 0,
        open: 0,
        negativeReaction: 0,
        humanReply: 1,
      },
    ])
  })
})

describe('formatStatsText', () => {
  const stats = feedbackStats([
    FINDING,
    finding({ id: 2, signals: [] }),
    finding({ id: 3, signals: [] }),
  ])

  it('shows the share of each destination and the warning line', () => {
    expect(formatStatsText(stats, undefined)).toBe(
      [
        'acme/shop: 3 comments · fixed 1 (33%) · dismissed 0 · ignored 0 · open 2 (67%) · negative reaction 1 · replied 0',
        '',
        'Signals, not verdicts: a dismissed finding may still have been right.',
        '',
      ].join('\n'),
    )
  })

  it('names the period', () => {
    expect(formatStatsText(stats, STARTED)).toMatch(/^Since \d{4}-\d\d-\d\d\.\n/)
  })

  it('says when nothing was published', () => {
    expect(formatStatsText([], undefined)).toBe(
      'No published comments in the history yet.\n\nSignals, not verdicts: a dismissed finding may still have been right.\n',
    )
  })
})

describe('formatStatsJson', () => {
  it('prints the stats with schemaVersion 1', () => {
    expect(JSON.parse(formatStatsJson(feedbackStats([FINDING]), STARTED))).toEqual({
      schemaVersion: 1,
      since: STARTED,
      repos: [
        {
          repo: 'acme/shop',
          published: 1,
          fixed: 1,
          dismissed: 0,
          ignored: 0,
          open: 0,
          negativeReaction: 1,
          humanReply: 0,
        },
      ],
    })
  })
})
