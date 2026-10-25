import { describe, expect, it } from 'vitest'
import type { Ci, CiReport, CiSummary } from '../context/types.js'
import type { CiCheck } from '../review/types.js'
import { formatCiLine, formatCiSection } from './format-ci.js'

const NO_CUTS: CiReport = {
  annotations: 0,
  omittedAnnotations: 0,
  logs: 0,
  omittedLogs: 0,
  truncated: 0,
  bytes: 120,
}

function ci(summary: CiSummary, checks: CiCheck[] = [], overrides: Partial<Ci> = {}): Ci {
  return { checks, entries: [], summary, report: NO_CUTS, ...overrides }
}

describe('formatCiLine', () => {
  it('counts the checks and names the failing ones', () => {
    expect(
      formatCiLine(ci({ state: 'failing', total: 5, failing: ['test'], pending: ['e2e'] })),
    ).toBe('CI: 5 checks, 1 failing (test), 1 pending')
  })

  it('says when every check passes or some are still running', () => {
    expect(formatCiLine(ci({ state: 'passing', total: 4, failing: [], pending: [] }))).toBe(
      'CI: 4 checks, all passing',
    )
    expect(formatCiLine(ci({ state: 'pending', total: 1, failing: [], pending: ['e2e'] }))).toBe(
      'CI: 1 check, 1 pending',
    )
  })

  it('names five failing checks at most', () => {
    const failing = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    expect(formatCiLine(ci({ state: 'failing', total: 7, failing, pending: [] }))).toBe(
      'CI: 7 checks, 7 failing (a, b, c, d, e, 2 more)',
    )
  })

  it('prints no line without checks and strips control characters from names', () => {
    expect(formatCiLine(ci({ state: 'none', total: 0, failing: [], pending: [] }))).toBeUndefined()
    expect(
      formatCiLine(ci({ state: 'failing', total: 1, failing: ['te\u001bst'], pending: [] })),
    ).toBe('CI: 1 check, 1 failing (test)')
  })
})

describe('formatCiSection', () => {
  it('lists each check that counts and what was left out or cut', () => {
    const checks: CiCheck[] = [
      {
        name: 'test',
        state: 'failing',
        conclusion: 'failure',
        title: '2 failed',
        annotations: ['src/a.ts:3 failure: boom', 'src/b.ts:9 warning: slow'],
        log: 'x'.repeat(2048),
      },
      { name: 'lint', state: 'failing', conclusion: 'timed_out' },
      { name: 'e2e', state: 'pending' },
      { name: 'build', state: 'passing' },
    ]
    const section = formatCiSection(
      ci({ state: 'failing', total: 4, failing: ['test', 'lint'], pending: ['e2e'] }, checks, {
        report: {
          annotations: 2,
          omittedAnnotations: 30,
          logs: 1,
          omittedLogs: 1,
          truncated: 2,
          bytes: 5300,
        },
        warnings: ['Job logs were not read: the token lacks actions:read'],
      }),
    )

    expect(section).toBe(
      [
        '## CI sent to the AI',
        '',
        '- test: failing (failure), 2 annotations, log 2.0 KB',
        '- lint: failing (timed_out)',
        '- e2e: pending',
        '- build: passing',
        '',
        'Sent: 5.2 KB, 2 annotations of 50, 1 log within 12 KB',
        'Left out: 30 annotations over 50, 1 log over 12 KB',
        'Cut: 2 texts (a title, summary, annotation or log)',
        'Warnings:',
        '- Job logs were not read: the token lacks actions:read',
        '',
      ].join('\n'),
    )
  })

  it('says when the head has no checks, keeping the warnings, and when CI is off', () => {
    expect(
      formatCiSection(
        ci({ state: 'none', total: 0, failing: [], pending: [] }, [], {
          warnings: ['CI check runs were not read: the token lacks checks:read'],
        }),
      ),
    ).toBe(
      '## CI sent to the AI\n\nNo checks.\nWarnings:\n- CI check runs were not read: the token lacks checks:read\n',
    )
    expect(formatCiSection(undefined)).toBe('## CI sent to the AI\n\nOff.\n')
  })
})
