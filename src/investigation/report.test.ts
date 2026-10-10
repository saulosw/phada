import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { buildInvestigationReport } from './report.js'
import { ToolLog } from './tool-log.js'

function logOf(...records: Parameters<ToolLog['add']>[0][]): ToolLog {
  const log = new ToolLog()
  for (const record of records) log.add(record)
  return log
}

const base = { pass: 'review' as const, durationMs: 3, bytes: 100 }

describe('buildInvestigationReport', () => {
  it('describes each call by its target and marks the ones used in a finding', () => {
    const log = logOf(
      { ...base, tool: 'read_file', args: { path: 'src/a.ts' }, paths: ['src/a.ts'] },
      {
        ...base,
        tool: 'read_file',
        args: { path: 'src/b.ts', from: 10, to: 20 },
        paths: ['src/b.ts'],
      },
      {
        ...base,
        tool: 'grep',
        args: { pattern: 'authorize\\(', path: 'src' },
        paths: ['src/c.ts'],
      },
      { ...base, tool: 'grep', args: { pattern: 'x' }, paths: [] },
      { ...base, pass: 'verify', tool: 'list', args: {}, paths: ['.'] },
      { ...base, tool: 'read_file', args: { path: 'big' }, paths: [], bytes: 0, error: 'budget' },
    )

    const report = buildInvestigationReport({
      status: 'used',
      log,
      findings: [findingFixture({ sources: ['src/b.ts:12', 'src/c.ts'] })],
      external: [{ server: 'linear', tool: 'get_issue' }],
    })

    expect(report).toEqual({
      status: 'used',
      calls: [
        {
          pass: 'review',
          tool: 'read_file',
          target: 'src/a.ts',
          bytes: 100,
          error: null,
          inSources: false,
        },
        {
          pass: 'review',
          tool: 'read_file',
          target: 'src/b.ts:10-20',
          bytes: 100,
          error: null,
          inSources: true,
        },
        {
          pass: 'review',
          tool: 'grep',
          target: 'authorize\\( in src',
          bytes: 100,
          error: null,
          inSources: true,
        },
        { pass: 'review', tool: 'grep', target: 'x', bytes: 100, error: null, inSources: false },
        { pass: 'verify', tool: 'list', target: '.', bytes: 100, error: null, inSources: false },
        {
          pass: 'review',
          tool: 'read_file',
          target: 'big',
          bytes: 0,
          error: 'budget',
          inSources: false,
        },
      ],
      external: [{ server: 'linear', tool: 'get_issue' }],
      totals: { calls: 6, bytes: 500 },
    })
  })

  it('reports an investigation that did not run', () => {
    expect(
      buildInvestigationReport({
        status: 'unavailable',
        reason: 'git was not found',
        findings: [],
      }),
    ).toEqual({
      status: 'unavailable',
      reason: 'git was not found',
      calls: [],
      external: [],
      totals: { calls: 0, bytes: 0 },
    })
  })
})
