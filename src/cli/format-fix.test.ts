import { describe, expect, it } from 'vitest'
import type { FindingsFix } from '../app/fix-findings.js'
import type { LocalFixTarget } from '../app/local-fix.js'
import { findingFixture } from '../../test/support/finding.js'
import {
  formatFixList,
  formatFixReport,
  formatFixWarnings,
  formatHeadMoved,
  formatNumberedList,
} from './format-fix.js'
import type { ListedFinding } from './format-fix.js'

const SUGGESTION = { startLine: 3, endLine: 3, original: 'a', replacement: 'b' }

function listedFinding(
  number: number,
  finding: Partial<ListedFinding['finding']> = {},
): ListedFinding {
  return {
    number,
    finding: { file: 'src/shop.ts', line: number, title: `finding ${number}`, ...finding },
  }
}

const AUTH = listedFinding(1, { severity: 'P0', title: 'no auth' })
const CLAMP = listedFinding(2, { severity: 'P1', title: 'goes negative', suggestion: SUGGESTION })
const STALE = listedFinding(3, { title: 'stale', suggestion: SUGGESTION })

function noAi(overrides: Partial<FindingsFix<ListedFinding>> = {}): FindingsFix<ListedFinding> {
  return { applied: [], changedFiles: [], left: [], ...overrides }
}

describe('the list of findings', () => {
  it('numbers each finding with its severity, place, title and whether it has a suggestion', () => {
    expect(formatNumberedList('Heading:', [AUTH, CLAMP, STALE])).toBe(
      [
        'Heading:',
        '1. P0 src/shop.ts:1 no auth',
        '2. P1 src/shop.ts:2 goes negative (suggestion)',
        '3. src/shop.ts:3 stale (suggestion)',
        '',
      ].join('\n'),
    )
  })

  it('heads the list of a local run with the run, the repository and the branch', () => {
    const target: LocalFixTarget = {
      repo: 'acme/shop',
      branch: 'feat/\u001bspend',
      run: 7,
      head: 'b'.repeat(40),
      reviewedHead: 'a'.repeat(40),
      findings: [{ number: 1, finding: findingFixture({ severity: 'P2', title: 'style' }) }],
    }

    expect(formatFixList(target)).toBe(
      'Findings of run 7 (acme/shop@feat/spend):\n1. P2 src/shop.ts:1 style\n',
    )
    expect(formatHeadMoved(target)).toBe(
      'Warning: HEAD moved from aaaaaaa to bbbbbbb since run 7 reviewed it; suggestions apply only where the code still matches.',
    )
  })
})

describe('the report of a fix', () => {
  it('says what the suggestions did and why each finding was left, with no AI', () => {
    expect(
      formatFixReport(
        noAi({
          applied: [CLAMP],
          changedFiles: ['src/shop.ts', 'src/cart.ts'],
          left: [
            { item: AUTH, reason: 'no-suggestion' },
            { item: STALE, reason: 'ambiguous' },
          ],
        }),
      ),
    ).toBe(
      [
        'Applied 1 suggestion: 2.',
        'Changed 2 files: src/shop.ts, src/cart.ts',
        'Left 2 findings:',
        '1. src/shop.ts:1 no auth: no suggestion',
        '3. src/shop.ts:3 stale: the suggested code appears more than once in the file',
        '',
      ].join('\n'),
    )
  })

  it('says nothing applied, changed or left', () => {
    expect(formatFixReport(noAi())).toBe(
      ['Applied no suggestion.', 'Changed no file.', 'Left no finding.', ''].join('\n'),
    )
  })

  it('names the files a failed AI changed before it failed', () => {
    const fix = noAi({
      left: [{ item: AUTH, reason: 'no-suggestion' }],
      ai: {
        status: 'failed',
        error: new Error('x'),
        provider: 'claude-cli',
        changedFiles: ['a.ts'],
      },
    })

    expect(formatFixReport(fix)).toBe(
      [
        'Applied no suggestion.',
        'Changed no file.',
        'claude-cli changed 1 file: a.ts before it failed',
        'Left 1 finding:',
        '1. src/shop.ts:1 no auth: no suggestion',
        '',
      ].join('\n'),
    )
  })

  it('says what the AI fixed, skipped and did not report, and its summary', () => {
    const fix = noAi({
      changedFiles: ['src/shop.ts'],
      left: [
        { item: AUTH, reason: 'no-suggestion' },
        { item: CLAMP, reason: 'not-found' },
        { item: STALE, reason: 'overlap' },
        { item: listedFinding(4), reason: 'missing-file' },
      ],
      ai: {
        status: 'answered',
        provider: 'fake-cli',
        changedFiles: ['src/shop.ts'],
        outcomes: [
          { number: 1, status: 'fixed', reason: '' },
          { number: 2, status: 'fixed', reason: 'clamped it' },
          { number: 3, status: 'skipped', reason: 'needs a decision' },
          { number: 4, status: 'skipped', reason: '' },
        ],
        unreported: [],
        summary: 'Did it.\n\u001b[31mred',
        blocked: [],
      },
    })

    expect(formatFixReport(fix)).toBe(
      [
        'Applied no suggestion.',
        'Changed 1 file: src/shop.ts',
        'fake-cli changed 1 file: src/shop.ts',
        'fake-cli fixed 2 findings:',
        '1. src/shop.ts:1 no auth',
        '2. src/shop.ts:2 goes negative (suggestion not applied: the suggestion no longer matches the file): clamped it',
        'Left 2 findings:',
        '3. src/shop.ts:3 stale (suggestion not applied: the suggestion overlaps one applied before it): skipped by fake-cli: needs a decision',
        '4. src/shop.ts:4 finding 4 (suggestion not applied: the file is not in the working tree): skipped by fake-cli',
        'Summary of fake-cli:',
        'Did it.\n[31mred',
        '',
      ].join('\n'),
    )
  })

  it('says the AI fixed no finding, names the unreported ones as left and leaves out an empty summary', () => {
    const fix = noAi({
      left: [{ item: AUTH, reason: 'no-suggestion' }],
      ai: {
        status: 'answered',
        provider: 'fake-cli',
        changedFiles: [],
        outcomes: [],
        unreported: [1],
        summary: '',
        blocked: [],
      },
    })

    expect(formatFixReport(fix)).toBe(
      [
        'Applied no suggestion.',
        'Changed no file.',
        'fake-cli changed no file.',
        'fake-cli fixed no finding.',
        'Left 1 finding:',
        '1. src/shop.ts:1 no auth: fake-cli did not say',
        '',
      ].join('\n'),
    )
  })
})

describe('the warnings of a fix', () => {
  it('warns nothing when no finding was left', () => {
    expect(formatFixWarnings(noAi())).toEqual([])
  })

  it('says only the suggestions were applied when there was no AI to edit', () => {
    expect(formatFixWarnings(noAi({ left: [{ item: AUTH, reason: 'no-suggestion' }] }))).toEqual([
      'Warning: phada fix applied only the suggestions: Claude Code or Codex edit the 1 finding left.',
    ])
  })

  it('warns nothing more when the AI failed', () => {
    const fix = noAi({
      left: [{ item: AUTH, reason: 'no-suggestion' }],
      ai: { status: 'failed', error: new Error('x'), provider: 'fake-cli', changedFiles: [] },
    })

    expect(formatFixWarnings(fix)).toEqual([])
  })

  it.each([
    [[1], 'Warning: fake-cli did not say what it did with finding 1; check it in git diff.'],
    [
      [1, 3],
      'Warning: fake-cli did not say what it did with findings 1, 3; check them in git diff.',
    ],
  ])('names the unreported findings %j', (unreported, warning) => {
    const fix = noAi({
      left: [{ item: AUTH, reason: 'no-suggestion' }],
      ai: {
        status: 'answered',
        provider: 'fake-cli',
        changedFiles: [],
        outcomes: [],
        unreported,
        summary: '',
        blocked: [],
      },
    })

    expect(formatFixWarnings(fix)).toEqual([warning])
  })

  it('names the commands the AI was refused on one line each', () => {
    const fix = noAi({
      left: [{ item: AUTH, reason: 'no-suggestion' }],
      ai: {
        status: 'answered',
        provider: 'fake-cli',
        changedFiles: [],
        outcomes: [{ number: 1, status: 'fixed', reason: '' }],
        unreported: [],
        summary: '',
        blocked: [
          { tool: 'Bash', input: 'npm\ntest' },
          { tool: 'Bash', input: 'rm -rf x' },
        ],
      },
    })

    expect(formatFixWarnings(fix)).toEqual([
      'Warning: fake-cli was refused 2 commands: Bash npm test, Bash rm -rf x',
    ])
  })
})
