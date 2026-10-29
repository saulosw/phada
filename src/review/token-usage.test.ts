import { describe, expect, it } from 'vitest'
import type { PassUsage, RecheckReport, RecheckVerdict } from './types.js'
import { sumUsage, usageReport } from './token-usage.js'

const REVIEW: PassUsage = {
  pass: 'review',
  usage: { inputTokens: 812_000, cachedInputTokens: 640_000, outputTokens: 9_000 },
}
const VERIFY: PassUsage = { pass: 'verify', usage: { inputTokens: 120_000, outputTokens: 2_000 } }

function recheck(by: RecheckVerdict['by'], usage?: RecheckReport['usage']): RecheckReport {
  return {
    threads: 1,
    fixed: 0,
    stillValid: 1,
    unsure: 0,
    verdicts: [
      { threadId: 't', file: 'a.ts', line: 1, title: 'x', verdict: 'still-valid', reason: '', by },
    ],
    durationMs: 0,
    ...(usage === undefined ? {} : { usage }),
  }
}

describe('sumUsage', () => {
  it('adds the cached tokens only when one of the two reports them', () => {
    expect(
      sumUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4 }),
    ).toEqual({ inputTokens: 4, outputTokens: 6 })
    expect(
      sumUsage(
        { inputTokens: 1, cachedInputTokens: 1, outputTokens: 2 },
        { inputTokens: 3, outputTokens: 4 },
      ),
    ).toEqual({ inputTokens: 4, cachedInputTokens: 1, outputTokens: 6 })
  })
})

describe('usageReport', () => {
  it('lists the passes of the review, then the recheck, with their total', () => {
    const report = usageReport(
      [REVIEW, VERIFY],
      recheck('ai', { inputTokens: 30_000, cachedInputTokens: 10_000, outputTokens: 1_000 }),
    )

    expect(report).toEqual({
      passes: [
        REVIEW,
        VERIFY,
        {
          pass: 'recheck',
          usage: { inputTokens: 30_000, cachedInputTokens: 10_000, outputTokens: 1_000 },
        },
      ],
      total: { inputTokens: 962_000, cachedInputTokens: 650_000, outputTokens: 12_000 },
    })
  })

  it('lists a recheck that asked the AI without tokens, and leaves out one that did not ask it', () => {
    expect(usageReport([REVIEW], recheck('ai')).passes).toEqual([REVIEW, { pass: 'recheck' }])
    expect(usageReport([REVIEW], recheck('unchanged')).passes).toEqual([REVIEW])
  })

  it('has no total when no pass reported tokens', () => {
    expect(usageReport([{ pass: 'review' }], undefined)).toEqual({ passes: [{ pass: 'review' }] })
    expect(usageReport(undefined, undefined)).toEqual({ passes: [] })
  })
})
