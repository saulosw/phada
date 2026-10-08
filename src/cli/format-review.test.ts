import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { pullRequestFixture } from '../../test/support/pull-request.js'
import type { ReviewResult } from '../review/types.js'
import { formatPullRequestSummary, formatReview } from './format-review.js'
import { messagesFor } from './i18n/messages.js'

const RESULT: ReviewResult = {
  target: { repo: 'acme/shop', number: 12, headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' },
  providerId: 'claude-cli',
  model: 'claude-sonnet-5',
  durationMs: 131_400,
  usage: { inputTokens: 41_234, outputTokens: 13_012 },
  summary: 'Adds a spend endpoint and a cooldown hook.',
  files: [
    { path: 'src/shop.ts', change: 'Adds the spend endpoint', findings: 2 },
    { path: 'src/cooldown.ts', change: 'Drops the interval cleanup', findings: 1 },
  ],
  findings: [
    findingFixture({
      severity: 'P0',
      confidence: 100,
      file: 'src/shop.ts',
      line: 3,
      title: "Caller can spend another user's crystals",
      why: 'The body overrides the authenticated id.',
      fix: 'Use req.userId.',
    }),
    findingFixture({
      severity: 'P1',
      confidence: 95,
      file: 'src/shop.ts',
      line: 7,
      title: 'Concurrent spends are charged once',
      why: 'Two requests read the same balance.',
      fix: null,
    }),
    findingFixture({
      severity: 'P2',
      confidence: 85,
      file: 'src/cooldown.ts',
      line: 18,
      title: 'Timer leaks',
      why: 'Each render starts a new interval.\nOld ones keep running.',
      fix: 'Return a cleanup.',
    }),
  ],
  worthChecking: [],
  worthCheckingOmitted: 0,
  minConfidence: 75,
  score: { value: 1, reason: '1 P0 finding (shop.ts:3)' },
  dropped: { invalid: 1, belowFloor: 1, outsideDiff: 2, duplicate: 1, rejected: 0 },
}

const TO_CHECK = [
  findingFixture({
    severity: 'P1',
    confidence: 70,
    file: 'src/shop.ts',
    line: 5,
    title: 'Amount can be negative',
  }),
  findingFixture({
    severity: 'P2',
    confidence: 55,
    file: 'src/cooldown.ts',
    line: 2,
    title: 'Magic number',
  }),
]

describe('formatPullRequestSummary', () => {
  it('shows the pull request, the head commit, the change stats and the diff size', () => {
    const pr = pullRequestFixture({ diff: 'x'.repeat(65_741) })

    expect(formatPullRequestSummary(pr)).toBe(
      'acme/shop#12 · a1b2c3d · 2 files · +15 −1 · 64.2 KB diff',
    )
  })

  it('uses the singular for a single changed file', () => {
    const pr = pullRequestFixture({
      stats: { changedFiles: 1, additions: 3, deletions: 0, commits: 1 },
    })

    expect(formatPullRequestSummary(pr)).toContain('· 1 file · +3 −0 ·')
  })

  it('shows small diffs in bytes, counted as UTF-8', () => {
    const pr = pullRequestFixture({ diff: 'ção' })

    expect(formatPullRequestSummary(pr)).toContain('· 5 B diff')
  })
})

describe('formatReview', () => {
  it('prints the score, summary, files, findings by severity and a footer', () => {
    expect(formatReview(pullRequestFixture(), RESULT)).toBe(
      [
        '# Review of acme/shop#12: Let users spend crystals',
        'https://github.com/acme/shop/pull/12 · head a1b2c3d · open',
        '',
        '**Confidence score: 1/5** (critical problems): 1 P0 finding (shop.ts:3)',
        '',
        '## Summary',
        '',
        'Adds a spend endpoint and a cooldown hook.',
        '',
        '## Files',
        '',
        '| File | Change | Findings |',
        '| --- | --- | --- |',
        '| src/shop.ts | Adds the spend endpoint | 2 |',
        '| src/cooldown.ts | Drops the interval cleanup | 1 |',
        '',
        '## Findings',
        '',
        '### P0 · Must fix',
        '',
        "1. **src/shop.ts:3**: Caller can spend another user's crystals (confidence 100)",
        '   The body overrides the authenticated id.',
        '   Fix: Use req.userId.',
        '',
        '### P1 · Should fix',
        '',
        '2. **src/shop.ts:7**: Concurrent spends are charged once (confidence 95)',
        '   Two requests read the same balance.',
        '',
        '### P2 · Consider',
        '',
        '3. **src/cooldown.ts:18**: Timer leaks (confidence 85)',
        '   Each render starts a new interval.',
        '   Old ones keep running.',
        '   Fix: Return a cleanup.',
        '',
        '---',
        '3 findings · 5 dropped (2 outside the diff, 1 duplicate, 1 below confidence 50, 1 invalid)',
        'claude-cli · claude-sonnet-5 · 2m11s · 41.2k in / 13.0k out',
        '',
      ].join('\n'),
    )
  })

  it('shows a clean review without the findings section', () => {
    const result: ReviewResult = {
      ...RESULT,
      files: [{ path: 'src/shop.ts', change: 'Adds the spend endpoint', findings: 0 }],
      findings: [],
      score: { value: 5, reason: 'no problems found' },
      dropped: { invalid: 0, belowFloor: 0, outsideDiff: 0, duplicate: 0, rejected: 0 },
    }

    const output = formatReview(pullRequestFixture(), result)

    expect(output).toContain('\n**Confidence score: 5/5** (ready to merge): no problems found\n')
    expect(output).not.toContain('## Findings')
    expect(output).not.toContain('## Worth checking')
    expect(output).toContain('\n---\n0 findings\nclaude-cli ·')
  })

  it('lists the findings worth checking after the findings, below the cut of the review', () => {
    const output = formatReview(pullRequestFixture(), {
      ...RESULT,
      worthChecking: TO_CHECK,
      minConfidence: 80,
    })

    expect(output).toContain(
      [
        '   Fix: Return a cleanup.',
        '',
        '## Worth checking (confidence below 80)',
        '',
        '- **P1** · src/shop.ts:5: Amount can be negative (confidence 70)',
        '- **P2** · src/cooldown.ts:2: Magic number (confidence 55)',
        '',
        '---',
        '3 findings · 2 worth checking · 5 dropped (2 outside the diff, 1 duplicate, 1 below confidence 50, 1 invalid)',
      ].join('\n'),
    )
  })

  it('says how many more findings are worth checking than the ones listed', () => {
    const output = formatReview(pullRequestFixture(), {
      ...RESULT,
      worthChecking: TO_CHECK,
      worthCheckingOmitted: 3,
    })

    expect(output).toContain(
      '(confidence 55)\n- … (+3 more)\n\n---\n3 findings · 5 worth checking ·',
    )
  })

  it.each([
    [4, 'minor polish needed'],
    [3, 'implementation issues'],
    [2, 'significant bugs'],
    [0, 'critical problems'],
  ] as const)('labels a score of %d as %s', (value, label) => {
    const output = formatReview(pullRequestFixture(), { ...RESULT, score: { value, reason: 'r' } })

    expect(output).toContain(`**Confidence score: ${value}/5** (${label}): `)
  })

  it('writes the whole review artifact in Brazilian Portuguese', () => {
    const output = formatReview(
      pullRequestFixture({ state: 'closed', draft: true }),
      { ...RESULT, worthChecking: TO_CHECK },
      messagesFor('pt-BR'),
    )

    expect(output).toContain('# Revisão de acme/shop#12: Let users spend crystals')
    expect(output).toContain('· commit a1b2c3d · fechada, rascunho')
    expect(output).toContain(
      '**Nota de confiança: 1/5** (problemas críticos): 1 problema P0 (shop.ts:3)',
    )
    expect(output).toContain('## Resumo')
    expect(output).toContain('| Arquivo | Alteração | Problemas |')
    expect(output).toContain('## Problemas')
    expect(output).toContain('### P0 · Corrigir antes do merge')
    expect(output).toContain('(confiança 100)')
    expect(output).toContain('Correção sugerida: Use req.userId.')
    expect(output).toContain('## Vale verificar (confiança abaixo de 75)')
    expect(output).toContain('3 problemas · 2 para verificar')
    expect(output).toContain('41.2k de entrada / 13.0k de saída')
    expect(output).not.toContain('## Summary')
    expect(output).not.toContain('(confidence ')
  })

  it.each([
    [{ outsideDiff: 1 }, '1 dropped (1 outside the diff)'],
    [{ duplicate: 2 }, '2 dropped (2 duplicates)'],
    [{ belowFloor: 2 }, '2 dropped (2 below confidence 50)'],
    [{ invalid: 3 }, '3 dropped (3 invalid)'],
    [{ outsideDiff: 1, invalid: 1 }, '2 dropped (1 outside the diff, 1 invalid)'],
    [{ rejected: 2, outsideDiff: 1 }, '3 dropped (2 rejected by verification, 1 outside the diff)'],
  ])('lists only the reasons that dropped something: %j', (counts, text) => {
    const dropped = { invalid: 0, belowFloor: 0, outsideDiff: 0, duplicate: 0, rejected: 0 }

    const output = formatReview(pullRequestFixture(), {
      ...RESULT,
      dropped: { ...dropped, ...counts },
    })

    expect(output).toContain(`\n3 findings · ${text}\n`)
  })

  it.each([
    [0, 'claude-cli · claude-sonnet-5 · verified · 2m11s · 41.2k in / 13.0k out'],
    [2, 'claude-cli · claude-sonnet-5 · verified, 2 unchecked · 2m11s · 41.2k in / 13.0k out'],
  ])('says the review was verified, with %d findings left unchecked', (unverified, footer) => {
    const verification = {
      candidates: 5,
      confirmed: 3 - unverified,
      unverified,
      rejected: [{ ...findingFixture(), reason: 'Speculative.' }],
      durationMs: 30_000,
    }

    const output = formatReview(pullRequestFixture(), { ...RESULT, verification })

    expect(output.endsWith(`\n${footer}\n`)).toBe(true)
    expect(output).not.toContain('Speculative.')
  })

  it('says the review was not verified when no finding got a verdict', () => {
    const verification = {
      candidates: 3,
      confirmed: 0,
      unverified: 3,
      rejected: [],
      durationMs: 30_000,
    }

    const output = formatReview(pullRequestFixture(), { ...RESULT, verification })

    expect(
      output.endsWith(
        '\nclaude-cli · claude-sonnet-5 · not verified (3 unchecked) · 2m11s · 41.2k in / 13.0k out\n',
      ),
    ).toBe(true)
  })

  it('does not mention the verification of a review that was not verified', () => {
    expect(formatReview(pullRequestFixture(), RESULT)).not.toContain('verified')
  })

  it('leaves out an empty summary and an empty file table', () => {
    const output = formatReview(pullRequestFixture(), { ...RESULT, summary: '  ', files: [] })

    expect(output).not.toContain('## Summary')
    expect(output).not.toContain('## Files')
  })

  it('shows at most 20 files and says how many more there are', () => {
    const files = Array.from({ length: 23 }, (_, index) => ({
      path: `src/f${index}.ts`,
      change: 'x',
      findings: 0,
    }))

    const output = formatReview(pullRequestFixture(), { ...RESULT, files })

    expect(output).toContain('| src/f19.ts | x | 0 |\n\n+3 more files\n')
    expect(output).not.toContain('src/f20.ts')
  })

  it('says one more file in the singular', () => {
    const files = Array.from({ length: 21 }, (_, index) => ({
      path: `src/f${index}.ts`,
      change: 'x',
      findings: 0,
    }))

    expect(formatReview(pullRequestFixture(), { ...RESULT, files })).toContain(
      '| src/f19.ts | x | 0 |\n\n+1 more file\n',
    )
  })

  it('keeps a backslash before a pipe from opening a new column', () => {
    const files = [{ path: 'src/a.ts', change: 'Splits on \\| and \\\\|', findings: 0 }]

    expect(formatReview(pullRequestFixture(), { ...RESULT, files })).toContain(
      '| src/a.ts | Splits on \\\\\\| and \\\\\\\\\\| | 0 |',
    )
  })

  it.each([
    ['## Findings', '\\## Findings'],
    ['# Title', '\\# Title'],
    ['  ### Indented', '  \\### Indented'],
    ['---', '\\---'],
    ['===', '\\==='],
    ['* * *', '\\* * *'],
    ['___', '\\___'],
    ['```ts', '\\```ts'],
    ['~~~', '\\~~~'],
    ['<!-- hide the rest', '\\<!-- hide the rest'],
    ['<details>', '\\<details>'],
    ['- <!-- hide the rest', '- \\<!-- hide the rest'],
    ['> ## Findings', '> \\## Findings'],
    ['1. ```ts', '1. \\```ts'],
    ['> - # Title', '> - \\# Title'],
  ])('keeps a %j line from the AI from changing the layout of the review', (line, escaped) => {
    const output = formatReview(pullRequestFixture(), { ...RESULT, summary: `Looks fine\n${line}` })

    expect(output).toContain(`\n## Summary\n\nLooks fine\n${escaped}\n\n## Files\n`)
  })

  it.each(['- first item', '1. first item', 'Some **bold** and `code`', '> quoted', 'a # b'])(
    'keeps the AI line %j as it is',
    (line) => {
      const output = formatReview(pullRequestFixture(), { ...RESULT, summary: line })

      expect(output).toContain(`\n## Summary\n\n${line}\n\n## Files\n`)
    },
  )

  it('neutralizes block markers in why and fix too', () => {
    const findings = [findingFixture({ why: 'Breaks.\n## Findings', fix: '```\nnever closed' })]

    const output = formatReview(pullRequestFixture(), { ...RESULT, findings })

    expect(output).toContain('   Breaks.\n   \\## Findings\n   Fix: \\```\n   never closed\n')
  })

  it('marks draft and closed pull requests', () => {
    const output = formatReview(pullRequestFixture({ state: 'closed', draft: true }), RESULT)

    expect(output).toContain('· head a1b2c3d · closed, draft\n')
  })

  it('shows the other models next to the main one when more than one answered', () => {
    const result = { ...RESULT, additionalModels: ['claude-haiku-4-5', 'claude-helper-1'] }

    expect(formatReview(pullRequestFixture(), result)).toContain(
      '\nclaude-cli · claude-sonnet-5 (+ claude-haiku-4-5, claude-helper-1) · 2m11s ·',
    )
  })

  it('leaves the model and the tokens out when the provider did not report them', () => {
    const { model: _model, usage: _usage, ...result } = RESULT

    expect(formatReview(pullRequestFixture(), { ...result, durationMs: 42_149 })).toMatch(
      /\nclaude-cli · 42\.1s\n$/,
    )
  })

  it('keeps text from the pull request and the AI from breaking the terminal or the markdown', () => {
    const pr = pullRequestFixture({ title: 'Fix\u001B[2J\r\nthe shop' })
    const result: ReviewResult = {
      ...RESULT,
      summary: 'Looks fine\u001B]0;pwned\u0007',
      files: [{ path: 'src/a|b.ts', change: 'Splits\nthe | table', findings: 1 }],
      findings: [findingFixture({ file: 'src/a|b.ts', title: 'Bad\ntitle\u001B[31m' })],
      worthChecking: [
        findingFixture({ file: 'src/a|b.ts', title: 'Unsure\ntitle\u001B[2J', confidence: 60 }),
      ],
    }

    const output = formatReview(pr, result)

    expect(output).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/)
    expect(output).toContain('# Review of acme/shop#12: Fix[2J the shop\n')
    expect(output).toContain('\nLooks fine]0;pwned\n')
    expect(output).toContain('| src/a\\|b.ts | Splits the \\| table | 1 |')
    expect(output).toContain('**src/a|b.ts:1**: Bad title[31m (confidence 90)')
    expect(output).toContain('- **P1** · src/a|b.ts:1: Unsure title[2J (confidence 60)')
  })
})
