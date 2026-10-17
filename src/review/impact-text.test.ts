import { describe, expect, it } from 'vitest'
import { IMPACT_BUDGET_BYTES, renderImpact } from './impact-text.js'
import { hasImpact } from './prompt-parts.js'
import type { DiffImpact, ImpactSite, ImpactedSymbol } from './types.js'

function site(line: number, fields: Partial<ImpactSite> = {}): ImpactSite {
  return {
    path: 'src/api.ts',
    line,
    in: 'handle',
    kind: 'calls',
    how: 'resolved',
    text: `getUser(${line})`,
    ...fields,
  }
}

function symbol(fields: Partial<ImpactedSymbol> = {}): ImpactedSymbol {
  return {
    kind: 'function',
    name: 'getUser',
    path: 'src/users.ts',
    startLine: 10,
    endLine: 30,
    exported: true,
    callers: 2,
    files: 1,
    sites: [site(42), site(57)],
    dependencies: [{ name: 'query', path: 'src/db.ts', line: 12, kind: 'function' }],
    ...fields,
  }
}

describe('renderImpact', () => {
  it('writes each changed symbol, its callers with their code and what it depends on', () => {
    const impact: DiffImpact = {
      symbols: [
        symbol({
          callers: 4,
          files: 3,
          sites: [
            site(42),
            site(18, {
              path: 'src/jobs/sync.ts',
              in: 'run',
              how: 'inferred',
              text: 'await repo.getUser(row.id)',
            }),
            site(3, {
              path: 'src/x.ts',
              in: undefined,
              kind: 'uses',
              how: 'observed',
              pullRequest: 12,
              text: 'const h = [getUser]',
            }),
          ],
        }),
        symbol({
          kind: 'method',
          name: 'helper',
          exported: false,
          callers: 0,
          files: 0,
          sites: [],
          dependencies: [],
        }),
      ],
      omittedSymbols: 0,
      callerFiles: 1,
    }

    expect(renderImpact(impact)).toEqual({
      text: [
        'function getUser (src/users.ts:10-30, exported) — 4 callers in 3 files',
        '  src/api.ts:42 in handle: getUser(42)',
        '  src/jobs/sync.ts:18 in run [inferred]: await repo.getUser(row.id)',
        '  src/x.ts:3 (uses) [observed #12]: const h = [getUser]',
        '  +1 more: use the callers tool',
        '  depends on: query → src/db.ts:12 (function)',
        'No callers or uses outside the diff: method helper (src/users.ts:10-30)',
      ].join('\n'),
      shown: [3, 0],
    })
  })

  it('cuts site by site at the budget and says how many symbols it left out', () => {
    const many = Array.from({ length: 40 }, (_, index) => site(index + 1))
    const impact: DiffImpact = {
      symbols: [symbol({ callers: 40, sites: many, dependencies: [] })],
      omittedSymbols: 2,
      callerFiles: 1,
    }

    const { text, shown } = renderImpact(impact, 400)

    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(400)
    expect(shown[0]).toBeGreaterThan(0)
    expect(shown[0]).toBeLessThan(40)
    expect(text).toContain(`  +${40 - (shown[0] ?? 0)} more: use the callers tool`)
    expect(text.endsWith('+2 more changed symbols')).toBe(true)
  })

  it('says when the search for callers was cut short', () => {
    const { text } = renderImpact({
      symbols: [
        symbol({ callers: 2000, files: 40, capped: true, sites: [site(4)], dependencies: [] }),
      ],
      omittedSymbols: 0,
      callerFiles: 40,
    })

    expect(text).toContain(
      'function getUser (src/users.ts:10-30, exported) — 2000+ callers in 40+ files (search cut short: use the callers tool with path)',
    )
  })

  it('keeps to its default budget of 4 KB', () => {
    const many = Array.from({ length: 200 }, (_, index) =>
      site(index + 1, { text: `getUser(${'x'.repeat(60)})` }),
    )

    const { text } = renderImpact({
      symbols: [symbol({ callers: 200, sites: many, dependencies: [] })],
      omittedSymbols: 0,
      callerFiles: 1,
    })

    expect(IMPACT_BUDGET_BYTES).toBe(4_000)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4_000)
  })

  it('names the repository of a site and of a dependency outside the reviewed one', () => {
    const impact: DiffImpact = {
      symbols: [
        symbol({
          callers: 1,
          sites: [site(42, { repo: 'acme/web', in: 'load' })],
          dependencies: [
            { name: 'query', repo: 'acme/db', path: 'src/query.ts', line: 12, kind: 'function' },
          ],
        }),
      ],
      omittedSymbols: 0,
      callerFiles: 1,
    }

    const { text } = renderImpact(impact)

    expect(text).toContain('  acme/web:src/api.ts:42 in load: getUser(42)')
    expect(text).toContain('depends on: query → acme/db:src/query.ts:12 (function)')
  })

  it('shows a symbol without callers that uses a related repository, with what it uses there', () => {
    const impact: DiffImpact = {
      symbols: [
        symbol({
          callers: 0,
          files: 0,
          sites: [],
          dependencies: [
            { name: 'query', repo: 'acme/db', path: 'src/query.ts', line: 12, kind: 'function' },
            { name: 'local', path: 'src/local.ts', line: 3, kind: 'function' },
          ],
        }),
      ],
      omittedSymbols: 0,
      callerFiles: 0,
    }

    const { text } = renderImpact(impact)

    expect(text).toBe(
      'function getUser (src/users.ts:10-30, exported) — no callers or uses found\n  depends on: query → acme/db:src/query.ts:12 (function), local → src/local.ts:3 (function)',
    )
    expect(hasImpact(impact)).toBe(true)
  })

  it('says one caller in one file', () => {
    expect(
      renderImpact({
        symbols: [symbol({ callers: 1, sites: [site(4)], dependencies: [] })],
        omittedSymbols: 0,
        callerFiles: 1,
      }).text,
    ).toContain('— 1 caller in 1 file')
  })
})
