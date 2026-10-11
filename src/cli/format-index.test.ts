import { describe, expect, it } from 'vitest'
import type { IndexReport } from '../app/index-repository.js'
import { formatIndexJson, formatIndexText } from './format-index.js'

const REPORT: IndexReport = {
  repository: 'acme/shop',
  commit: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
  ref: 'HEAD',
  durationMs: 3_140,
  files: { total: 470, indexed: 412, extracted: 37, reused: 375 },
  summary: {
    files: {
      indexed: 412,
      ignored: 22,
      'no-grammar': 31,
      'too-large': 3,
      binary: 1,
      'parse-timeout': 0,
      symlink: 1,
      submodule: 0,
    },
    languages: { typescript: 301, javascript: 64, python: 47 },
    symbols: { parameter: 2_310, function: 1_204, class: 1, method: 388 },
    imports: 1_930,
    exports: 812,
    calls: 6_402,
    parseErrors: 2,
  },
  leftOut: [
    ...['a.md', 'b.md', 'c.md', 'd.json', 'e.json', 'f.yml', 'Makefile', 'g.toml'].map((path) => ({
      path,
      reason: 'no-grammar' as const,
    })),
    { path: 'big.ts', reason: 'too-large' },
    { path: 'img.ts', reason: 'binary' },
    { path: 'link.ts', reason: 'symlink' },
  ],
  rebuilt: true,
  warnings: [],
  indexPath: '/home/u/.cache/phada/index/acme/shop.sqlite',
}
const SIZES = {
  index: 2_500_000,
  mirror: 6_400_000,
  mirrorPath: '/home/u/.cache/phada/repos/acme/shop.git',
}

describe('formatIndexText', () => {
  it('prints what was indexed, what was left out and where the index lives', () => {
    expect(formatIndexText(REPORT, SIZES, '/home/u')).toBe(
      [
        'Indexed acme/shop at 1a2b3c4 (default branch) in 3.1s',
        'Index rebuilt: the format changed.',
        'Files: 412 indexed (37 read, 375 unchanged) · 11 left out',
        'Languages: TypeScript 301 · JavaScript 64 · Python 47',
        'Symbols: 1,204 functions · 388 methods · 1 class · 2,310 parameters',
        'Imports 1,930 · exports 812 · calls 6,402 · 2 parse errors',
        'Left out: 8 no grammar (.md 3, .json 2, (none) 1, other 2) · 1 too large · 1 binary · 1 symbolic link',
        'Index: ~/.cache/phada/index/acme/shop.sqlite (2.4 MB) · mirror 6.1 MB',
        '',
      ].join('\n'),
    )
  })

  it('names the ref it indexed and leaves out empty lines', () => {
    const text = formatIndexText(
      {
        ...REPORT,
        ref: 'release',
        rebuilt: false,
        leftOut: [],
        files: { total: 0, indexed: 0, extracted: 0, reused: 0 },
        summary: { ...REPORT.summary, languages: {}, symbols: {}, parseErrors: 0 },
      },
      SIZES,
      '/elsewhere',
    )

    expect(text).toContain('Indexed acme/shop at 1a2b3c4 (release) in 3.1s\n')
    expect(text).toContain('Files: 0 indexed (0 read, 0 unchanged)\n')
    expect(text).toContain('Languages: none\n')
    expect(text).toContain('Symbols: none\n')
    expect(text).toContain('Imports 1,930 · exports 812 · calls 6,402\n')
    expect(text).not.toContain('Left out')
    expect(text).toContain('Index: /home/u/.cache/phada/index/acme/shop.sqlite (2.4 MB)')
  })

  it('does not repeat a commit given as the ref', () => {
    const text = formatIndexText({ ...REPORT, ref: REPORT.commit }, SIZES, '/home/u')

    expect(text.split('\n')[0]).toBe('Indexed acme/shop at 1a2b3c4 in 3.1s')
  })
})

describe('formatIndexJson', () => {
  it('prints every field with the full list of files left out', () => {
    const json = JSON.parse(formatIndexJson(REPORT, SIZES))

    expect(json).toEqual({
      schemaVersion: 1,
      repository: 'acme/shop',
      commit: REPORT.commit,
      ref: 'HEAD',
      durationMs: 3_140,
      files: REPORT.files,
      languages: REPORT.summary.languages,
      symbols: REPORT.summary.symbols,
      imports: 1_930,
      exports: 812,
      calls: 6_402,
      parseErrors: 2,
      leftOut: REPORT.leftOut,
      rebuilt: true,
      warnings: [],
      index: { path: REPORT.indexPath, bytes: 2_500_000 },
      mirror: { path: SIZES.mirrorPath, bytes: 6_400_000 },
    })
  })
})
