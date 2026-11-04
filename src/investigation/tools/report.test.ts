import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../../test/support/finding.js'
import { buildInvestigationReport } from './report.js'
import { ToolLog } from './tool-log.js'

function logOf(...records: Parameters<ToolLog['add']>[0][]): ToolLog {
  const log = new ToolLog()
  for (const record of records) log.add(record)
  return log
}

const base = { pass: 'review' as const, durationMs: 3, bytes: 100, touched: [] }

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
          server: null,
          target: 'src/a.ts',
          bytes: 100,
          error: null,
          inSources: false,
        },
        {
          pass: 'review',
          tool: 'read_file',
          server: null,
          target: 'src/b.ts:10-20',
          bytes: 100,
          error: null,
          inSources: true,
        },
        {
          pass: 'review',
          tool: 'grep',
          server: null,
          target: 'authorize\\( in src',
          bytes: 100,
          error: null,
          inSources: true,
        },
        {
          pass: 'review',
          tool: 'grep',
          server: null,
          target: 'x',
          bytes: 100,
          error: null,
          inSources: false,
        },
        {
          pass: 'verify',
          tool: 'list',
          server: null,
          target: '.',
          bytes: 100,
          error: null,
          inSources: false,
        },
        {
          pass: 'review',
          tool: 'read_file',
          server: null,
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

  it('describes the graph and history queries by their target', () => {
    const log = logOf(
      { ...base, tool: 'find_symbol', args: { name: 'getUser', kind: 'function' }, paths: [] },
      { ...base, tool: 'callers', args: { name: 'getUser', path: 'src/users.ts' }, paths: [] },
      { ...base, tool: 'dependencies', args: { name: 'load' }, paths: [] },
      { ...base, tool: 'similar', args: { name: 'handleOrder' }, paths: [] },
      { ...base, tool: 'history', args: { path: 'src/a.ts', from: 10, to: 20 }, paths: [] },
      { ...base, tool: 'history', args: { path: 'src/b.ts' }, paths: [] },
    )

    const report = buildInvestigationReport({ status: 'used', log, findings: [] })

    expect(report.calls.map((call) => `${call.tool} ${call.target}`)).toEqual([
      'find_symbol getUser (function)',
      'callers getUser in src/users.ts',
      'dependencies load',
      'similar handleOrder',
      'history src/a.ts:10-20',
      'history src/b.ts',
    ])
  })

  it('names the server of an MCP call and shows its arguments as compact JSON', () => {
    const log = logOf(
      {
        ...base,
        tool: 'tickets__get_ticket',
        server: 'tickets',
        args: { id: 'ABC-1', note: 'x'.repeat(100) },
        paths: [],
      },
      { ...base, tool: 'read_file', args: { path: 'src/a.ts' }, paths: ['src/a.ts'] },
    )

    const report = buildInvestigationReport({
      status: 'used',
      log,
      findings: [],
      mcp: [
        { server: 'tickets', via: 'phada', status: 'connected', tools: ['get_ticket'], hidden: [] },
      ],
    })

    expect(report.calls[0]?.server).toBe('tickets')
    expect(report.calls[0]?.target).toBe(`{"id":"ABC-1","note":"${'x'.repeat(57)}…`)
    expect(report.calls[0]?.target).toHaveLength(80)
    expect(report.calls[1]?.server).toBeNull()
    expect(report.mcp).toEqual([
      { server: 'tickets', via: 'phada', status: 'connected', tools: ['get_ticket'], hidden: [] },
    ])
  })

  it('has no mcp block without MCP', () => {
    expect(buildInvestigationReport({ status: 'used', findings: [] })).not.toHaveProperty('mcp')
  })
})
