import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { CheckAnnotation } from '../github/check-runs.js'
import type { JobLog } from '../github/job-log.js'
import {
  CI_LOG_TOTAL_BYTES,
  CI_MAX_ANNOTATIONS,
  buildCi,
  ciLogsLeft,
  keepsAnnotation,
} from './ci.js'
import { CI_LOG_JOB_BYTES } from './ci-log.js'
import type { CiEntry } from './types.js'

const JOB_LOG = readFileSync(
  new URL('../../test/fixtures/github/job-log.txt', import.meta.url),
  'utf8',
)
const NO_DETAILS = { annotations: new Map(), logs: new Map() }

function failing(name: string, id: number, overrides: Partial<CiEntry> = {}): CiEntry {
  return {
    name,
    kind: 'check-run',
    id,
    actions: true,
    state: 'failing',
    conclusion: 'failure',
    ...overrides,
  }
}

function annotation(overrides: Partial<CheckAnnotation> = {}): CheckAnnotation {
  return {
    path: 'src/cart.ts',
    line: 12,
    level: 'failure',
    title: null,
    message: 'expected 3 to be 2',
    ...overrides,
  }
}

function log(text: string, partial = false): JobLog {
  return { text, partial }
}

describe('buildCi', () => {
  it('lists failing checks first with their details, then pending, then passing by name', () => {
    const entries: CiEntry[] = [
      {
        name: 'build',
        kind: 'check-run',
        id: 1,
        actions: true,
        state: 'passing',
        conclusion: 'success',
      },
      { name: 'e2e', kind: 'check-run', id: 2, actions: true, state: 'pending' },
      failing('test', 3, { title: 'Tests failed', summary: '2 of 40 failed' }),
      {
        name: 'scan',
        kind: 'status',
        actions: false,
        state: 'failing',
        conclusion: 'error',
        title: 'Scan crashed',
      },
    ]

    const ci = buildCi(entries, {
      annotations: new Map([
        [
          3,
          [
            annotation({ title: 'cart.test.ts' }),
            annotation({
              path: '.github',
              line: 1,
              message: 'Process completed with exit code 1.',
            }),
            annotation({
              path: '.github',
              line: 1,
              level: 'notice',
              message: 'Runner ubuntu-24.04',
            }),
            annotation({ path: 'src/a.ts', line: 3, level: 'warning', message: 'unused import' }),
          ],
        ],
      ]),
      logs: new Map([[3, log(JOB_LOG)]]),
    })

    expect(ci.checks.map(({ name, state }) => [name, state])).toEqual([
      ['test', 'failing'],
      ['scan', 'failing'],
      ['e2e', 'pending'],
      ['build', 'passing'],
    ])
    const [test, scan, e2e, build] = ci.checks
    expect(test).toEqual({
      name: 'test',
      state: 'failing',
      conclusion: 'failure',
      title: 'Tests failed',
      summary: '2 of 40 failed',
      annotations: [
        'src/cart.ts:12 failure: cart.test.ts: expected 3 to be 2',
        '.github:1 failure: Process completed with exit code 1.',
        'src/a.ts:3 warning: unused import',
      ],
      log: expect.stringMatching(
        /^##\[group\]Run go mod tidy -diff\n[\s\S]*##\[error\]Process completed with exit code 1\.$/,
      ),
    })
    expect(scan).toEqual({
      name: 'scan',
      state: 'failing',
      conclusion: 'error',
      title: 'Scan crashed',
    })
    expect(e2e).toEqual({ name: 'e2e', state: 'pending' })
    expect(build).toEqual({ name: 'build', state: 'passing' })
    expect(ci.summary).toEqual({
      state: 'failing',
      total: 4,
      failing: ['test', 'scan'],
      pending: ['e2e'],
    })
    expect(ci.report).toEqual({
      annotations: 3,
      omittedAnnotations: 0,
      logs: 1,
      omittedLogs: 0,
      truncated: 0,
      bytes: expect.any(Number),
    })
  })

  it('has no checks and a state of none without entries', () => {
    expect(buildCi([], NO_DETAILS)).toEqual({
      checks: [],
      summary: { state: 'none', total: 0, failing: [], pending: [] },
      report: {
        annotations: 0,
        omittedAnnotations: 0,
        logs: 0,
        omittedLogs: 0,
        truncated: 0,
        bytes: 0,
      },
    })
  })

  it(`keeps at most ${CI_MAX_ANNOTATIONS} annotations over the failing checks in order`, () => {
    const many = Array.from({ length: 40 }, (_, index) => annotation({ line: index + 1 }))
    const ci = buildCi([failing('test', 1), failing('lint', 2)], {
      annotations: new Map([
        [1, many],
        [2, many],
      ]),
      logs: new Map(),
    })

    expect(ci.checks[0]?.annotations).toHaveLength(40)
    expect(ci.checks[1]?.annotations).toHaveLength(10)
    expect(ci.report).toMatchObject({ annotations: 50, omittedAnnotations: 30 })
  })

  it('cuts a long summary and a long annotation message, counting the cuts', () => {
    const ci = buildCi([failing('test', 1, { summary: 's'.repeat(5000) })], {
      annotations: new Map([[1, [annotation({ message: 'm'.repeat(3000) })]]]),
      logs: new Map(),
    })

    const [check] = ci.checks
    expect(check?.summary).toMatch(/^s{2048}\n\[truncated by Phada: 2048 of 5000 bytes\]$/)
    expect(check?.annotations?.[0]).toMatch(
      /^src\/cart\.ts:12 failure: m{1024}\n\[truncated by Phada: 1024 of 3000 bytes\]$/,
    )
    expect(ci.report.truncated).toBe(2)
  })

  it(`keeps ${CI_LOG_JOB_BYTES / 1024} KB per job and ${CI_LOG_TOTAL_BYTES / 1024} KB of logs in total, in the order of the failing checks`, () => {
    const long = Array.from({ length: 2000 }, (_, index) => `line ${index}`).join('\n')
    const entries = [failing('a', 1), failing('b', 2), failing('c', 3)]
    const logs = new Map([
      [1, log(`${long}\n##[error]a failed`)],
      [2, log(`${long}\n##[error]b failed`)],
      [3, log(`${long}\n##[error]c failed`)],
    ])

    const ci = buildCi(entries, { annotations: new Map(), logs })
    const [a, b, c] = ci.checks
    const bytes = (text = '') => new TextEncoder().encode(text).length

    expect(bytes(a?.log)).toBeLessThanOrEqual(CI_LOG_JOB_BYTES + 64)
    expect(a?.log?.endsWith('##[error]a failed')).toBe(true)
    expect(bytes(a?.log) + bytes(b?.log)).toBeLessThanOrEqual(CI_LOG_TOTAL_BYTES + 128)
    expect(b?.log?.endsWith('##[error]b failed')).toBe(true)
    expect(c?.log).toBeUndefined()
    expect(ci.report).toMatchObject({ logs: 2, omittedLogs: 1, truncated: 2 })
  })

  it('drops the half line a range read starts with', () => {
    const ci = buildCi([failing('a', 1)], {
      annotations: new Map(),
      logs: new Map([[1, log('lf line\n##[group]Run make\n##[error]boom', true)]]),
    })

    expect(ci.checks[0]?.log).toBe('##[group]Run make\n##[error]boom')
  })
})

describe('ciLogsLeft', () => {
  it('says how many bytes of logs are left once the logs read so far are cut', () => {
    const entries = [failing('a', 1), failing('b', 2)]

    expect(ciLogsLeft(entries, new Map())).toBe(CI_LOG_TOTAL_BYTES)
    expect(ciLogsLeft(entries, new Map([[1, log('##[error]boom')]]))).toBe(CI_LOG_TOTAL_BYTES - 13)
  })
})

describe('keepsAnnotation', () => {
  it('keeps failures and warnings, not notices', () => {
    expect(keepsAnnotation(annotation())).toBe(true)
    expect(keepsAnnotation(annotation({ level: 'warning' }))).toBe(true)
    expect(keepsAnnotation(annotation({ level: 'notice' }))).toBe(false)
  })
})
