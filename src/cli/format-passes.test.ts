import { describe, expect, it } from 'vitest'
import { formatPassesLine, formatPassesSection } from './format-passes.js'

describe('formatPassesLine', () => {
  it('lists the planned skills and the skipped ones with the reason', () => {
    expect(
      formatPassesLine([
        { skill: 'phada', origin: 'phada', status: 'planned', mode: 'text' },
        { skill: 'code-review', origin: '/s/SKILL.md', status: 'planned', mode: 'text' },
        {
          skill: 'sec',
          origin: '/s/sec/SKILL.md',
          status: 'skipped',
          mode: 'text',
          reason: 'no changed file matches src/auth/**',
        },
      ]),
    ).toBe('Skills: phada, code-review (skipped: sec — no changed file matches src/auth/**)')
  })
})

describe('formatPassesSection', () => {
  it('shows each pass with its origin, findings, time and tokens', () => {
    expect(
      formatPassesSection([
        {
          skill: 'phada',
          origin: 'phada',
          status: 'reviewed',
          durationMs: 12_000,
          usage: { inputTokens: 9_700, outputTokens: 417 },
          findings: 2,
        },
        {
          skill: 'code-review',
          origin: '/s/SKILL.md',
          status: 'failed',
          durationMs: 0,
          findings: 0,
          reason: 'claude exited with 1',
        },
        {
          skill: 'sec',
          origin: '/s/sec/SKILL.md',
          status: 'skipped',
          durationMs: 0,
          findings: 0,
          reason: 'no changed file matches src/auth/**',
        },
      ]),
    ).toBe(
      [
        '## Skills',
        '',
        '- phada (built-in): 2 findings · 12.0s · 9.7k in / 417 out tokens',
        '- code-review (/s/SKILL.md): failed — claude exited with 1',
        '- sec (/s/sec/SKILL.md): skipped — no changed file matches src/auth/**',
        '',
      ].join('\n'),
    )
  })
})
