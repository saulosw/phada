import { describe, expect, it } from 'vitest'
import type { UsageReport } from '../review/token-usage.js'
import { formatUsageLine, formatUsageSection } from './format-usage.js'

const REPORT: UsageReport = {
  passes: [
    {
      pass: 'review',
      usage: { inputTokens: 812_000, cachedInputTokens: 640_000, outputTokens: 9_000 },
    },
    { pass: 'verify', usage: { inputTokens: 120_000, outputTokens: 2_000 } },
    { pass: 'recheck' },
  ],
  total: { inputTokens: 932_000, cachedInputTokens: 640_000, outputTokens: 11_000 },
}

describe('formatUsageLine', () => {
  it('names each pass with its tokens, then the total', () => {
    expect(formatUsageLine(REPORT)).toBe(
      'Tokens: review 812.0k in (640.0k cached) · 9.0k out; verify 120.0k in · 2.0k out; recheck not reported; total 932.0k in (640.0k cached) · 11.0k out',
    )
  })

  it('names a skill pass by its skill and leaves out the total of a single pass', () => {
    const usage = { inputTokens: 900, outputTokens: 40 }

    expect(
      formatUsageLine({ passes: [{ pass: 'review', skill: 'code-review', usage }], total: usage }),
    ).toBe('Tokens: code-review 900 in · 40 out')
  })

  it('says when no pass reported its tokens, and prints nothing without an AI call', () => {
    expect(formatUsageLine({ passes: [{ pass: 'review' }] })).toBe('Tokens: review not reported')
    expect(formatUsageLine({ passes: [] })).toBeUndefined()
  })

  it('cleans the name of a skill before it reaches the terminal', () => {
    expect(formatUsageLine({ passes: [{ pass: 'review', skill: 'evil\u001b[2J' }] })).toBe(
      'Tokens: evil[2J not reported',
    )
  })
})

describe('formatUsageSection', () => {
  it('lists each pass and the total', () => {
    expect(formatUsageSection(REPORT)).toBe(
      '## Tokens\n\n' +
        '- review: 812.0k in (640.0k cached) · 9.0k out\n' +
        '- verify: 120.0k in · 2.0k out\n' +
        '- recheck: not reported\n' +
        '- total: 932.0k in (640.0k cached) · 11.0k out\n',
    )
  })

  it('says when the review made no AI call', () => {
    expect(formatUsageSection({ passes: [] })).toBe('## Tokens\n\nNo AI call.\n')
  })
})
