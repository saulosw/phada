import { describe, expect, it } from 'vitest'
import { formatPassesLine, formatPassesSection, formatSkillRunLines } from './format-passes.js'

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

describe('native skill passes', () => {
  const native = {
    skill: 'code-review:code-review',
    origin: '/p',
    status: 'reviewed' as const,
    mode: 'native' as const,
    durationMs: 372_000,
    findings: 2,
    output: 'x'.repeat(9000),
    captured: 2,
    blocked: [{ tool: 'Bash', input: 'npm test' }],
  }
  const fixFor = (blocked: { input: string }) =>
    `allow it with review.commands: ["${blocked.input}"] in /cfg/config.yml`

  it('marks the native skills in the Skills line', () => {
    expect(
      formatPassesLine([
        { skill: 'phada', origin: 'phada', status: 'planned', mode: 'text' },
        { skill: 'code-review:code-review', origin: '/p', status: 'planned', mode: 'native' },
      ]),
    ).toBe('Skills: phada, code-review:code-review (native)')
  })

  it('says how the native run went and how to allow each blocked command', () => {
    expect(formatSkillRunLines([native], fixFor)).toEqual([
      'Skill code-review:code-review: ran natively in 6m12s, 2 GitHub writes captured, 1 blocked',
      '  blocked npm test (allow it with review.commands: ["npm test"] in /cfg/config.yml)',
    ])
    expect(formatSkillRunLines([{ ...native, mode: undefined }], fixFor)).toEqual([])
  })

  it('shows the skill output in the dry-run section, cut at 8 KB', () => {
    const section = formatPassesSection([native], fixFor)

    expect(section).toContain('- code-review:code-review (/p): native · 2 findings')
    expect(section).toContain(
      '  - blocked: npm test — allow it with review.commands: ["npm test"] in /cfg/config.yml',
    )
    expect(section).toContain('### Skill output: code-review:code-review')
    expect(section).toContain(`${'x'.repeat(8192)}\n[cut at 8 KB; the JSON output has all of it]`)
    expect(section).not.toContain('x'.repeat(8193))
  })
})
