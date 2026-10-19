import { describe, expect, it } from 'vitest'
import { findingFixture } from '../../test/support/finding.js'
import { parseDiffFiles } from './diff-lines.js'
import { checkSuggestion, MAX_SUGGESTION_LINES } from './suggestions.js'
import type { Suggestion } from './types.js'

function diffOf(...lines: string[]): string {
  return `${lines.join('\n')}\n`
}

const DIFF = diffOf(
  'diff --git a/src/shop.ts b/src/shop.ts',
  '--- a/src/shop.ts',
  '+++ b/src/shop.ts',
  '@@ -1,4 +1,5 @@',
  " import { db } from './db'",
  '-const LIMIT = 10',
  '+const LIMIT = 20',
  '+const FEE = 1',
  ' ',
  ' export function spend() {',
  '@@ -20,3 +21,3 @@ export function spend() {',
  '   const user = db.find()',
  '-  return user',
  '+  return { user }',
  ' }',
)

const FILES = parseDiffFiles(DIFF)

function check(suggestion: Suggestion, line = suggestion.startLine) {
  return checkSuggestion(findingFixture({ file: 'src/shop.ts', line, suggestion }), FILES)
}

describe('checkSuggestion', () => {
  it('accepts a one-line replacement of a line of the diff', () => {
    const suggestion = {
      startLine: 2,
      endLine: 2,
      original: 'const LIMIT = 20',
      replacement: 'const LIMIT = 15',
    }

    expect(check(suggestion)).toEqual(suggestion)
  })

  it('accepts a replacement of several lines of one @@ section', () => {
    const suggestion = {
      startLine: 2,
      endLine: 4,
      original: 'const LIMIT = 20\nconst FEE = 1\n\n',
      replacement: 'const LIMIT = 20\nconst FEE = 2\n',
    }

    expect(check(suggestion, 3)).toEqual(suggestion)
  })

  it('accepts CRLF original', () => {
    expect(
      check({
        startLine: 2,
        endLine: 3,
        original: 'const LIMIT = 20\r\nconst FEE = 1\r\n',
        replacement: 'const LIMIT = 5',
      }),
    ).toBeDefined()
  })

  it('accepts an empty replacement that deletes the lines', () => {
    expect(
      check({ startLine: 3, endLine: 3, original: 'const FEE = 1', replacement: '' }),
    ).toBeDefined()
  })

  it('refuses a range that ends before it starts', () => {
    expect(check({ startLine: 3, endLine: 2, original: '', replacement: 'x' }, 3)).toBeUndefined()
  })

  it(`refuses more than ${MAX_SUGGESTION_LINES} lines`, () => {
    const lines = Array.from({ length: MAX_SUGGESTION_LINES + 1 }, (_, index) => `+line ${index}`)
    const files = parseDiffFiles(
      diffOf(
        'diff --git a/src/big.ts b/src/big.ts',
        '--- a/src/big.ts',
        '+++ b/src/big.ts',
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines,
      ),
    )
    const original = lines.map((line) => line.slice(1)).join('\n')
    const finding = findingFixture({
      file: 'src/big.ts',
      line: 1,
      suggestion: { startLine: 1, endLine: lines.length, original, replacement: 'x' },
    })

    expect(checkSuggestion(finding, files)).toBeUndefined()
  })

  it('refuses a range that does not hold the line of the finding', () => {
    expect(
      check({ startLine: 2, endLine: 2, original: 'const LIMIT = 20', replacement: 'x' }, 5),
    ).toBeUndefined()
  })

  it('refuses a range that crosses two @@ sections', () => {
    expect(
      check({ startLine: 5, endLine: 21, original: 'whatever', replacement: 'x' }),
    ).toBeUndefined()
  })

  it('refuses lines that are not in the diff', () => {
    expect(
      check({ startLine: 7, endLine: 7, original: 'anything', replacement: 'x' }),
    ).toBeUndefined()
  })

  it('refuses a file that is not in the diff', () => {
    const finding = findingFixture({
      file: 'src/other.ts',
      line: 2,
      suggestion: { startLine: 2, endLine: 2, original: 'const LIMIT = 20', replacement: 'x' },
    })

    expect(checkSuggestion(finding, FILES)).toBeUndefined()
  })

  it('refuses an original that differs from the lines of the diff', () => {
    expect(
      check({ startLine: 2, endLine: 2, original: 'const LIMIT =  20', replacement: 'x' }),
    ).toBeUndefined()
  })

  it('refuses a replacement equal to the original', () => {
    expect(
      check({
        startLine: 2,
        endLine: 2,
        original: 'const LIMIT = 20',
        replacement: 'const LIMIT = 20\n',
      }),
    ).toBeUndefined()
  })

  it('returns nothing for a finding without a suggestion', () => {
    expect(checkSuggestion(findingFixture({ file: 'src/shop.ts', line: 2 }), FILES)).toBeUndefined()
  })
})
