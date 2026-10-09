import { describe, expect, it } from 'vitest'
import { contextReportFixture } from '../../test/support/context-report.js'
import { formatContextLine, formatContextSection } from './format-context.js'

const EMPTY = contextReportFixture({
  rules: [],
  docs: [],
  ignored: [],
  budget: { limit: 60_000, used: 0 },
})

describe('formatContextLine', () => {
  it('counts the applied rules, the docs sent with their size, what was omitted and ignored', () => {
    expect(formatContextLine(contextReportFixture())).toBe(
      'Context: 1 rule · 2 docs (23.6 KB, 1 omitted) · 1 file ignored',
    )
  })

  it('uses plurals and leaves out what is empty', () => {
    const report = contextReportFixture({
      rules: [
        { key: 'a', origin: 'x', status: 'applied' },
        { key: 'b', origin: 'x', status: 'applied' },
      ],
      docs: [],
      ignored: ['a.lock', 'b.lock'],
      budget: { limit: 60_000, used: 0 },
    })

    expect(formatContextLine(report)).toBe('Context: 2 rules · 0 docs · 2 files ignored')
  })

  it('says when nothing was sent', () => {
    expect(formatContextLine(EMPTY)).toBe('Context: no rules or docs')
  })
})

describe('formatContextSection', () => {
  it('lists the rules, docs and ignored files sent with a dry run', () => {
    expect(formatContextSection(contextReportFixture())).toBe(
      [
        '## Context sent to the AI',
        '',
        'Rules:',
        '- orm-only (.phada/config.yml)',
        '- no-console (.phada/config.yml, disabled)',
        '- py-only (.phada/config.yml, out of scope)',
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
