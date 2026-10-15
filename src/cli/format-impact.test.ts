import { describe, expect, it } from 'vitest'
import type { ImpactReport } from '../graph/report.js'
import { formatImpactLine, formatImpactSection } from './format-impact.js'

const used: ImpactReport = {
  status: 'used',
  index: { files: 120, extracted: 3, durationMs: 840 },
  changed: [
    {
      kind: 'function',
      name: 'getUser',
      path: 'src/users.ts',
      lines: [1, 3],
      callers: 9,
      files: 5,
      shown: 3,
      dependencies: 1,
    },
    {
      kind: 'method',
      name: 'load',
      path: 'src/users.ts',
      lines: [5, 9],
      callers: 3,
      files: 2,
      shown: 2,
      dependencies: 0,
    },
    {
      kind: 'class',
      name: 'Users',
      path: 'src/users.ts',
      lines: [4, 20],
      callers: 0,
      files: 0,
      shown: 0,
      dependencies: 0,
    },
  ],
  totals: { symbols: 3, callers: 12, files: 7 },
  learned: [],
}

describe('formatImpactLine', () => {
  it('sums up the changed symbols and their callers', () => {
    expect(formatImpactLine(used)).toBe('Impact: 3 changed symbols · 12 callers in 7 files')
    expect(
      formatImpactLine({
        ...used,
        changed: used.changed.slice(0, 1),
        totals: { symbols: 1, callers: 1, files: 1 },
      }),
    ).toBe('Impact: 1 changed symbol · 1 caller in 1 file')
  })

  it('says when nothing indexed changed, when there is no graph and nothing when it is off', () => {
    expect(
      formatImpactLine({ ...used, changed: [], totals: { symbols: 0, callers: 0, files: 0 } }),
    ).toBe('Impact: no indexed symbols changed')
    expect(
      formatImpactLine({
        ...used,
        status: 'unavailable',
        reason: 'index of acme/shop is not ready\u001b[2J',
        changed: [],
      }),
    ).toBe('Impact: unavailable (index of acme/shop is not ready[2J)')
    expect(formatImpactLine({ ...used, status: 'off', changed: [] })).toBeUndefined()
  })
})

describe('formatImpactSection', () => {
  it('shows the text the AI got and what this review learned', () => {
    const section = formatImpactSection(
      {
        ...used,
        learned: [{ from: 'src/users.ts getUser', to: 'src/routes.ts', pullRequest: 12 }],
      },
      'function getUser (src/users.ts:1-3, exported) — 9 callers in 5 files\n  src/a.ts:3 in x: getUser()\u001b[31m',
    )

    expect(section).toBe(
      [
        '## Impact',
        '',
        'function getUser (src/users.ts:1-3, exported) — 9 callers in 5 files',
        '  src/a.ts:3 in x: getUser()[31m',
        '',
        'Learned: src/users.ts getUser → src/routes.ts (from #12)',
        '',
      ].join('\n'),
    )
  })

  it('explains why there is no impact', () => {
    expect(
      formatImpactSection(
        { ...used, status: 'unavailable', reason: 'git was not found', changed: [] },
        undefined,
      ),
    ).toBe('## Impact\n\nNot available: git was not found.\n')
    expect(formatImpactSection({ ...used, status: 'off', changed: [] }, undefined)).toBe(
      '## Impact\n\nOff.\n',
    )
    expect(
      formatImpactSection(
        { ...used, changed: [], totals: { symbols: 0, callers: 0, files: 0 } },
        undefined,
      ),
    ).toBe('## Impact\n\nNo indexed symbols changed.\n')
  })
})
