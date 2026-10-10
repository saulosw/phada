import { describe, expect, it } from 'vitest'
import type { InvestigationReport } from '../investigation/tools/report.js'
import { formatInvestigationLine, formatInvestigationSection } from './format-investigation.js'

const call = (
  tool: string,
  target: string,
  fields: Partial<InvestigationReport['calls'][number]> = {},
) => ({
  pass: 'review' as const,
  tool,
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
})
