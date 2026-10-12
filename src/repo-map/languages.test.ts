import { describe, expect, it } from 'vitest'
import { languageOf } from './languages.js'

describe('languageOf', () => {
  it.each([
    ['src/a.ts', 'typescript'],
    ['src/A.TS', 'typescript'],
    ['types/x.d.ts', 'typescript'],
    ['a.mts', 'typescript'],
    ['a.cts', 'typescript'],
    ['ui/App.tsx', 'tsx'],
    ['a.js', 'javascript'],
    ['a.mjs', 'javascript'],
    ['a.cjs', 'javascript'],
    ['a.jsx', 'javascript'],
    ['pkg/mod.py', 'python'],
    ['stubs/mod.pyi', 'python'],
    ['cmd/main.go', 'go'],
  ])('maps %s to %s', (path, language) => {
    expect(languageOf(path)).toBe(language)
  })

  it.each(['Makefile', 'a.json', 'README.md', '.ts', 'dir.ts/file', 'a.ts.bak'])(
    'has no grammar for %s',
    (path) => {
      expect(languageOf(path)).toBeUndefined()
    },
  )
})
