import { describe, expect, it } from 'vitest'
import { diffFingerprint } from './diff-fingerprint.js'

function diffOf(...lines: string[]): string {
  return `${lines.join('\n')}\n`
}

const BASE = diffOf(
  'diff --git a/src/shop.ts b/src/shop.ts',
  'index 1111111..2222222 100644',
  '--- a/src/shop.ts',
  '+++ b/src/shop.ts',
  '@@ -1,4 +1,4 @@',
  " import { db } from './db'",
  '-const LIMIT = 10',
  '+const LIMIT = 20',
  ' export {}',
)

describe('diffFingerprint', () => {
  it('gives the same 16 hex characters for the same diff', () => {
    expect(diffFingerprint(BASE)).toMatch(/^[0-9a-f]{16}$/)
    expect(diffFingerprint(BASE)).toBe(diffFingerprint(BASE))
  })

  it('ignores hunk headers and context', () => {
    const shifted = diffOf(
      'diff --git a/src/shop.ts b/src/shop.ts',
      'index 3333333..4444444 100644',
      '--- a/src/shop.ts',
      '+++ b/src/shop.ts',
      '@@ -11,4 +14,4 @@ export function spend() {',
      " import { db } from './database'",
      '-const LIMIT = 10',
      '+const LIMIT = 20',
      ' export { db }',
    )

    expect(diffFingerprint(shifted)).toBe(diffFingerprint(BASE))
  })

  it('changes when an added or removed line changes', () => {
    expect(diffFingerprint(BASE.replace('+const LIMIT = 20', '+const LIMIT = 30'))).not.toBe(
      diffFingerprint(BASE),
    )
    expect(diffFingerprint(BASE.replace('-const LIMIT = 10', '-const LIMIT = 11'))).not.toBe(
      diffFingerprint(BASE),
    )
  })

  it('changes when the file is another one or was renamed', () => {
    expect(diffFingerprint(BASE.replaceAll('src/shop.ts', 'src/cart.ts'))).not.toBe(
      diffFingerprint(BASE),
    )
    const renamed = BASE.replace(
      'index 1111111..2222222 100644',
      'rename from src/old.ts\nrename to src/shop.ts',
    )
    expect(diffFingerprint(renamed)).not.toBe(diffFingerprint(BASE))
  })

  it('gives a fingerprint to an empty diff', () => {
    expect(diffFingerprint('')).toMatch(/^[0-9a-f]{16}$/)
  })
})
