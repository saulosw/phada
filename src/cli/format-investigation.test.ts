import { describe, expect, it } from 'vitest'
import type { InvestigationReport } from '../investigation/tools/report.js'
import type { Coverage } from '../review/types.js'
import { formatInvestigationLine, formatInvestigationSection } from './format-investigation.js'

const call = (
  tool: string,
  target: string,
  fields: Partial<InvestigationReport['calls'][number]> = {},
) => ({
  pass: 'review' as const,
  tool,
  server: null,
  target,
  bytes: 2048,
  error: null,
  inSources: false,
  ...fields,
})

const used: InvestigationReport = {
  status: 'used',
  calls: [
    call('read_file', 'src/a.ts:1-40', { inSources: true }),
    call('read_file', 'src/b.ts'),
    call('grep', 'authorize\\('),
    call('list', '.', { pass: 'verify' }),
    call('read_file', 'big.ts', { bytes: 0, error: 'budget' }),
  ],
  external: [],
  totals: { calls: 5, bytes: 8192 },
}

describe('formatInvestigationLine', () => {
  it('counts reads, searches and listings', () => {
    expect(formatInvestigationLine(used)).toBe('Investigated: 3 reads, 1 search, 1 list (8.0 KB)')
  })

  it('adds the calls to the MCP servers of the user', () => {
    expect(
      formatInvestigationLine({
        ...used,
        external: [
          { server: 'linear', tool: 'get_issue' },
          { server: 'linear', tool: 'search' },
          { server: 'notion', tool: 'fetch' },
        ],
      }),
    ).toBe('Investigated: 3 reads, 1 search, 1 list (8.0 KB) · 3 MCP calls (linear, notion)')
  })

  it('counts the MCP calls made through Phada with the ones made by the AI CLI', () => {
    expect(
      formatInvestigationLine({
        ...used,
        calls: [
          call('read_file', 'src/a.ts'),
          call('tickets__get_ticket', '{"id":"ABC-1"}', { server: 'tickets' }),
          call('tickets__search', '{}', { server: 'tickets' }),
        ],
        external: [{ server: 'linear', tool: 'get_issue' }],
        totals: { calls: 3, bytes: 6144 },
      }),
    ).toBe('Investigated: 1 read (6.0 KB) · 3 MCP calls (tickets, linear)')
  })

  it('shows only the MCP calls when the AI made no other call', () => {
    expect(
      formatInvestigationLine({
        ...used,
        calls: [],
        external: [{ server: 'linear', tool: 'get_issue' }],
        totals: { calls: 0, bytes: 0 },
      }),
    ).toBe('Investigated: 1 MCP call (linear)')
  })

  it('counts graph queries and history lookups', () => {
    expect(
      formatInvestigationLine({
        ...used,
        calls: [
          call('read_file', 'src/a.ts'),
          call('callers', 'getUser'),
          call('find_symbol', 'getUser'),
          call('similar', 'f'),
          call('history', 'src/a.ts'),
        ],
        totals: { calls: 5, bytes: 10240 },
      }),
    ).toBe('Investigated: 1 read, 3 graph queries, 1 history lookup (10.0 KB)')
  })

  it('says when the AI read nothing', () => {
    expect(formatInvestigationLine({ ...used, calls: [], totals: { calls: 0, bytes: 0 } })).toBe(
      'Investigated: no tool calls',
    )
  })

  it('says when the investigation is off', () => {
    expect(formatInvestigationLine({ ...used, status: 'off', calls: [] })).toBe(
      'Investigation: off',
    )
  })

  it('prints nothing when the investigation could not start', () => {
    expect(formatInvestigationLine({ ...used, status: 'unavailable', calls: [] })).toBeUndefined()
  })
})

describe('formatInvestigationSection', () => {
  it('lists every call', () => {
    expect(formatInvestigationSection(used)).toBe(
      [
        '## Investigation',
        '',
        '- read_file src/a.ts:1-40 (2.0 KB) · used in a finding',
        '- read_file src/b.ts (2.0 KB)',
        '- grep authorize\\( (2.0 KB)',
        '- list . (2.0 KB) · verification',
        '- read_file big.ts · error: budget',
        '',
      ].join('\n'),
    )
  })

  it('marks the calls of the recheck of earlier comments', () => {
    const recheck = {
      ...used,
      calls: [
        {
          pass: 'recheck' as const,
          tool: 'read_file',
          server: null,
          target: 'src/a.ts',
          bytes: 10,
          error: null,
          inSources: false,
        },
      ],
    }

    expect(formatInvestigationSection(recheck)).toContain('- read_file src/a.ts (10 B) · recheck')
  })

  it('lists the MCP calls and strips control characters', () => {
    expect(
      formatInvestigationSection({
        status: 'used',
        calls: [call('grep', 'a\u0007b')],
        external: [{ server: 'linear', tool: 'get_issue' }],
        totals: { calls: 1, bytes: 2048 },
      }),
    ).toBe(['## Investigation', '', '- grep ab (2.0 KB)', '- MCP linear: get_issue', ''].join('\n'))
  })

  it('lists the calls through Phada and each MCP server with its state', () => {
    expect(
      formatInvestigationSection({
        status: 'used',
        calls: [call('tickets__get_ticket', '{"id":"ABC-1"}', { server: 'tickets', bytes: 1229 })],
        external: [],
        mcp: [
          { server: 'linear', via: 'cli', status: 'connected', tools: [], hidden: [] },
          { server: 'jira', via: 'cli', status: 'connected', tools: ['get_issue'], hidden: [] },
          {
            server: 'tickets',
            via: 'phada',
            status: 'connected',
            tools: ['get_ticket', 'search'],
            hidden: ['create_ticket'],
          },
          {
            server: 'big',
            via: 'phada',
            status: 'connected',
            tools: [],
            hidden: ['a', 'b', 'c', 'd', 'e', 'f'],
          },
          {
            server: 'docs',
            via: 'phada',
            status: 'failed',
            tools: [],
            hidden: [],
            reason: 'MCP server docs refused the credentials (HTTP 401).',
          },
          { server: 'off\u0007', via: 'phada', status: 'off', tools: [], hidden: [] },
        ],
        totals: { calls: 1, bytes: 1229 },
      }),
    ).toBe(
      [
        '## Investigation',
        '',
        '- tickets__get_ticket {"id":"ABC-1"} (1.2 KB)',
        '- MCP linear (AI CLI): connected',
        '- MCP jira (AI CLI): connected, tools get_issue',
        '- MCP tickets: connected, 2 tools (1 hidden: create_ticket)',
        '- MCP big: connected, 0 tools (6 hidden: a, b, c, d, e, …)',
        '- MCP docs: failed: MCP server docs refused the credentials (HTTP 401).',
        '- MCP off: off (outside author)',
        '',
      ].join('\n'),
    )
  })

  it('explains an investigation that did not run', () => {
    expect(formatInvestigationSection({ ...used, status: 'off', calls: [] })).toBe(
      '## Investigation\n\nOff.\n',
    )
    expect(
      formatInvestigationSection({
        ...used,
        status: 'unavailable',
        reason: 'git was not found',
        calls: [],
      }),
    ).toBe('## Investigation\n\nNot available: git was not found.\n')
  })

  describe('coverage', () => {
    const partial: Coverage = {
      level: 'partial',
      covered: 4,
      total: 5,
      declaredOnly: 1,
      skipped: 0,
      gaps: [
        { path: 'src/new.ts', kind: 'not-compared' },
        { path: 'src/read.ts', kind: 'declared-only' },
      ],
      verified: true,
      reason: '1 new file not compared with existing code, 1 file declared as read but never read',
    }
    const one = {
      ...used,
      calls: [call('read_file', 'src/b.ts')],
      totals: { calls: 1, bytes: 2048 },
    }

    it('follows the calls with a coverage below full and each gap', () => {
      expect(formatInvestigationSection(one, partial)).toBe(
        [
          '## Investigation',
          '',
          '- read_file src/b.ts (2.0 KB)',
          '',
          'Coverage: partial, 4 of 5 files — 1 new file not compared with existing code, 1 file declared as read but never read',
          '- src/new.ts: new file not compared with existing code',
          '- src/read.ts: declared as read but never read',
          '',
        ].join('\n'),
      )
    })

    it('says what the coverage was before a continuation pass', () => {
      const after: Coverage = {
        ...partial,
        continuation: { before: { level: 'low', covered: 2, total: 9 } },
      }

      expect(formatInvestigationSection(one, after)).toContain(
        'Coverage: partial, 4 of 5 files — 1 new file not compared with existing code, 1 file declared as read but never read, after a continuation pass (was low, 2 of 9)\n',
      )
    })

    it('says the coverage is declared, with the reason a skip gave, even without the tools', () => {
      const declared: Coverage = {
        level: 'low',
        covered: 1,
        total: 3,
        declaredOnly: 0,
        skipped: 1,
        gaps: [
          { path: 'yarn.lock', kind: 'skipped', reason: 'lockfile\u0007' },
          { path: 'src/b.ts', kind: 'missing' },
        ],
        verified: false,
        reason: '1 file not accounted for, 1 file skipped',
      }

      expect(formatInvestigationSection({ ...used, status: 'off', calls: [] }, declared)).toBe(
        [
          '## Investigation',
          '',
          'Off.',
          '',
          'Coverage (declared): low, 1 of 3 files — 1 file not accounted for, 1 file skipped',
          '- yarn.lock: skipped (lockfile)',
          '- src/b.ts: not accounted for',
          '',
        ].join('\n'),
      )
    })

    it('caps the list of gaps', () => {
      const gaps = Array.from({ length: 23 }, (_, index) => ({
        path: `src/f${index}.ts`,
        kind: 'missing' as const,
      }))
      const low: Coverage = {
        ...partial,
        level: 'low',
        covered: 0,
        total: 23,
        declaredOnly: 0,
        gaps,
      }

      const section = formatInvestigationSection(one, low)

      expect(section).toContain('- src/f19.ts: not accounted for\n- … (+3 more)\n')
      expect(section).not.toContain('src/f20.ts')
    })

    it('leaves the coverage out when it is full', () => {
      const full: Coverage = { ...partial, level: 'full', covered: 5, gaps: [] }

      expect(formatInvestigationSection(one, full)).toBe(formatInvestigationSection(one))
      expect(formatInvestigationSection(one)).not.toContain('Coverage')
    })
  })
})
