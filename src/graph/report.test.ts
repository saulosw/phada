import { describe, expect, it } from 'vitest'
import type { DiffImpact } from '../review/types.js'
import { buildImpactReport } from './report.js'

const IMPACT: DiffImpact = {
  symbols: [
    {
      kind: 'function',
      name: 'getUser',
      path: 'src/users.ts',
      startLine: 1,
      endLine: 3,
      exported: true,
      callers: 4,
      files: 3,
      capped: true,
      sites: [],
      dependencies: [{ name: 'query', path: 'src/db.ts', line: 1, kind: 'function' }],
    },
    {
      kind: 'method',
      name: 'load',
      path: 'src/users.ts',
      startLine: 5,
      endLine: 9,
      exported: false,
      callers: 2,
      files: 1,
      sites: [],
      dependencies: [],
    },
  ],
  omittedSymbols: 0,
  callerFiles: 3,
}

describe('buildImpactReport', () => {
  it('sums up the changed symbols, their callers and the files they are in', () => {
    const report = buildImpactReport({
      status: 'used',
      index: { files: 120, extracted: 3, durationMs: 840 },
      impact: IMPACT,
      shown: [3, 2],
      learned: [
        {
          from: { path: 'src/users.ts', kind: 'function', name: 'getUser' },
          to: { path: 'src/routes.ts' },
          pullRequest: 12,
          commit: 'c'.repeat(40),
        },
      ],
    })

    expect(report).toEqual({
      status: 'used',
      index: { files: 120, extracted: 3, durationMs: 840 },
      changed: [
        {
          kind: 'function',
          name: 'getUser',
          path: 'src/users.ts',
          lines: [1, 3],
          callers: 4,
          files: 3,
          shown: 3,
          dependencies: 1,
          capped: true,
        },
        {
          kind: 'method',
          name: 'load',
          path: 'src/users.ts',
          lines: [5, 9],
          callers: 2,
          files: 1,
          shown: 2,
          dependencies: 0,
          capped: false,
        },
      ],
      totals: { symbols: 2, callers: 6, files: 3 },
      learned: [{ from: 'src/users.ts getUser', to: 'src/routes.ts', pullRequest: 12 }],
    })
  })

  it('reports why there is no impact', () => {
    expect(
      buildImpactReport({ status: 'unavailable', reason: 'index of acme/shop is not ready' }),
    ).toEqual({
      status: 'unavailable',
      reason: 'index of acme/shop is not ready',
      changed: [],
      totals: { symbols: 0, callers: 0, files: 0 },
      learned: [],
    })
  })
})
