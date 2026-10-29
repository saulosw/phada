import { describe, expect, it } from 'vitest'
import { contextReportFixture } from '../../test/support/context-report.js'
import { docLine, formatContextLine, formatContextSection, ruleLine } from './format-context.js'

const EMPTY = contextReportFixture({
  rules: [],
  docs: [],
  ignored: [],
  budget: { limit: 60_000, used: 0 },
})

const BASE = 'abc1234def5678901234567890123456789abcde'

describe('formatContextLine', () => {
  it('names the base and counts the applied rules, the docs sent with their size, what was omitted and ignored', () => {
    expect(formatContextLine(contextReportFixture(), BASE)).toBe(
      'Context at base abc1234: 1 rule · 2 docs (23.6 KB, 1 omitted) · 1 file ignored',
    )
  })

  it('uses plurals and leaves out what is empty', () => {
    const report = contextReportFixture({
      rules: [
        { key: 'a', origin: 'x', scope: ['**'], status: 'applied' },
        { key: 'b', origin: 'x', scope: ['**'], status: 'applied' },
      ],
      docs: [],
      ignored: ['a.lock', 'b.lock'],
      budget: { limit: 60_000, used: 0 },
    })

    expect(formatContextLine(report, BASE)).toBe(
      'Context at base abc1234: 2 rules · 0 docs · 2 files ignored',
    )
  })

  it('counts the docs that did not apply apart from the omitted ones', () => {
    const doc = { origin: 'repository' as const, category: 'agents' as const, bytes: 10 }
    const report = contextReportFixture({
      rules: [],
      ignored: [],
      docs: [
        { ...doc, path: 'AGENTS.md', status: 'included' },
        { ...doc, path: 'a.mdc', status: 'omitted', reason: 'out-of-scope', scope: ['lib/**'] },
        { ...doc, path: 'b.mdc', status: 'omitted', reason: 'manual' },
        { ...doc, path: 'c.instructions.md', status: 'omitted', reason: 'excluded' },
        { ...doc, path: 'docs/big.md', status: 'omitted', reason: 'budget' },
      ],
      budget: { limit: 60_000, used: 10 },
    })

    expect(formatContextLine(report, BASE)).toBe(
      'Context at base abc1234: 0 rules · 1 doc (10 B, 1 omitted, 3 not applied)',
    )
  })

  it('says when nothing was sent', () => {
    expect(formatContextLine(EMPTY, BASE)).toBe('Context at base abc1234: no rules or docs')
  })
})

describe('formatContextSection', () => {
  it('lists the rules, docs and ignored files sent with a dry run', () => {
    expect(formatContextSection(contextReportFixture())).toBe(
      [
        '## Context sent to the AI',
        '',
        'Rules:',
        '- orm-only (.phada/config.yml, **/*.py)',
        '- no-console (.phada/config.yml, disabled)',
        '- py-only (.phada/config.yml, **/*.py, out of scope)',
        '',
        'Docs:',
        '- docs/conventions.md (4.1 KB)',
        '- README.md (24.4 KB, truncated)',
        '- docs/guide.md (29.3 KB, omitted: budget)',
        '',
        'Ignored files:',
        '- package-lock.json',
        '',
      ].join('\n'),
    )
  })

  it('says when nothing was sent', () => {
    expect(formatContextSection(EMPTY)).toBe('## Context sent to the AI\n\nNo rules or docs.\n')
  })

  it('strips control characters from paths written in the repository', () => {
    const report = contextReportFixture({
      rules: [],
      docs: [],
      ignored: ['evil\u001B[2J.lock'],
    })

    expect(formatContextSection(report)).toContain('- evil[2J.lock')
  })
})

describe('ruleLine', () => {
  it('shows the severity and scope of a rule, leaving out a scope that covers everything', () => {
    expect(
      ruleLine({
        key: 'paginate',
        origin: '.phada/config.yml',
        scope: ['src/**'],
        severity: 'P1',
        status: 'applied',
      }),
    ).toBe('paginate (.phada/config.yml, P1, src/**)')
    expect(ruleLine({ key: 'a', origin: 'x', scope: ['**'], status: 'listed' })).toBe('a (x)')
  })
})

describe('docLine', () => {
  const doc = {
    path: '.github/instructions/backend.instructions.md',
    origin: 'repository' as const,
    category: 'agents' as const,
    bytes: 1200,
  }

  it('says where a scoped doc applies and why a doc was left out', () => {
    expect(docLine({ ...doc, status: 'included', scope: ['src/backend/**'] })).toBe(
      '.github/instructions/backend.instructions.md (1.2 KB, applies to src/backend/**)',
    )
    expect(
      docLine({ ...doc, status: 'omitted', reason: 'out-of-scope', scope: ['src/backend/**'] }),
    ).toBe('.github/instructions/backend.instructions.md (1.2 KB, out of scope: src/backend/**)')
    expect(docLine({ ...doc, status: 'omitted', reason: 'manual' })).toBe(
      '.github/instructions/backend.instructions.md (1.2 KB, not applied: only attached by hand)',
    )
    expect(docLine({ ...doc, status: 'omitted', reason: 'excluded' })).toBe(
      '.github/instructions/backend.instructions.md (1.2 KB, not applied: excludeAgent code-review)',
    )
    expect(docLine({ ...doc, status: 'listed', scope: ['a/**', 'b/**'] })).toBe(
      '.github/instructions/backend.instructions.md (1.2 KB, applies to a/**, b/**)',
    )
  })
})
