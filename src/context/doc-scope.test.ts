import { describe, expect, it } from 'vitest'
import { docScope, scopeMatcher } from './doc-scope.js'

const mdc = (front: string, dir = '') => docScope('mdc', `---\n${front}\n---\n# Rule\n`, dir)
const instructions = (front: string) => docScope('instructions', `---\n${front}\n---\n# Rule\n`, '')

describe('docScope', () => {
  it('applies an mdc file always when alwaysApply is true, even with globs', () => {
    expect(mdc('alwaysApply: true\nglobs: src/**')).toEqual({ kind: 'always' })
  })

  it('scopes an mdc file to its globs', () => {
    expect(mdc('globs: src/**')).toEqual({ kind: 'globs', patterns: ['src/**'] })
  })

  it('applies an mdc file with only a description and leaves a bare one manual', () => {
    expect(mdc('description: Database access rules')).toEqual({ kind: 'always' })
    expect(mdc('alwaysApply: false')).toEqual({ kind: 'manual' })
    expect(docScope('mdc', '# Rule without front matter\n', '')).toEqual({ kind: 'manual' })
  })

  it('treats a pattern that matches everything as always', () => {
    expect(mdc("globs: '**'")).toEqual({ kind: 'always' })
    expect(instructions("applyTo: '*'")).toEqual({ kind: 'always' })
  })

  it('scopes an instructions file to applyTo and leaves it manual without one', () => {
    expect(instructions('applyTo: "src/backend/**"')).toEqual({
      kind: 'globs',
      patterns: ['src/backend/**'],
    })
    expect(instructions('description: Backend')).toEqual({ kind: 'manual' })
    expect(docScope('instructions', 'Always use UTC.\n', '')).toEqual({ kind: 'manual' })
  })

  it('excludes an instructions file meant to stay out of code review', () => {
    expect(instructions('applyTo: "**"\nexcludeAgent: "code-review"')).toEqual({
      kind: 'excluded',
    })
    expect(instructions('applyTo: src/**\nexcludeAgent: coding-agent')).toEqual({
      kind: 'globs',
      patterns: ['src/**'],
    })
  })

  it('matches a pattern without a slash in any folder', () => {
    expect(mdc('globs: *.ts, src/**')).toEqual({
      kind: 'globs',
      patterns: ['**/*.ts', 'src/**'],
    })
  })

  it('makes the patterns of a nested mdc file relative to its folder', () => {
    expect(mdc('globs: src/**, *.tsx', 'packages/web')).toEqual({
      kind: 'globs',
      patterns: ['packages/web/src/**', 'packages/web/**/*.tsx'],
    })
    expect(mdc('globs: x/**', 'a[1]')).toEqual({ kind: 'globs', patterns: ['a\\[1\\]/x/**'] })
    expect(mdc("globs: '**'", 'packages/web')).toEqual({
      kind: 'globs',
      patterns: ['packages/web/**'],
    })
  })

  it('drops a leading slash and reports an unreadable front matter', () => {
    expect(mdc('globs: /src/**')).toEqual({ kind: 'globs', patterns: ['src/**'] })
    expect(docScope('mdc', '---\nglobs: src/**\n', '')).toEqual({ kind: 'invalid' })
  })

  it('keeps negated patterns as exclusions, also in a nested folder', () => {
    expect(mdc('globs: src/**, !src/**/*.test.ts')).toEqual({
      kind: 'globs',
      patterns: ['src/**', '!src/**/*.test.ts'],
    })
    expect(mdc('globs: "!*.test.ts"', 'web')).toEqual({
      kind: 'globs',
      patterns: ['web/**', '!web/**/*.test.ts'],
    })
    expect(mdc("globs: '**', '!docs/**'")).toEqual({ kind: 'globs', patterns: ['**', '!docs/**'] })
  })
})

describe('scopeMatcher', () => {
  it('matches a file that some pattern covers and no negated pattern excludes', () => {
    const matches = scopeMatcher(['src/**', '!src/**/*.test.ts'])
    expect(matches('src/a.ts')).toBe(true)
    expect(matches('src/a.test.ts')).toBe(false)
    expect(matches('lib/a.ts')).toBe(false)
  })

  it('treats a scope of only negated patterns as everything else', () => {
    const matches = scopeMatcher(['!web/**/*.test.ts'])
    expect(matches('web/a.ts')).toBe(true)
    expect(matches('web/a.test.ts')).toBe(false)
  })
})
