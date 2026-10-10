import { describe, expect, it } from 'vitest'
import { BINARY, DELETED, MODIFIED, RENAMED } from '../../test/support/diff-sections.js'
import { splitDiff } from './split-diff.js'

describe('splitDiff', () => {
  it('splits a diff by file with the new path, the old one for deletions', () => {
    const diff = MODIFIED + DELETED + RENAMED + BINARY

    const { preamble, sections } = splitDiff(diff)

    expect(preamble).toBe('')
    expect(sections.map((section) => section.path)).toEqual([
      'src/a.ts',
      'old.ts',
      'y.ts',
      'logo.png',
    ])
    expect(sections.map((section) => section.text).join('')).toBe(diff)
  })

  it('reads quoted paths', () => {
    const quoted =
      'diff --git "a/my file.ts" "b/my file.ts"\n--- "a/my file.ts"\n+++ "b/my file.ts"\n@@ -1 +1 @@\n-a\n+b\n'

    expect(splitDiff(quoted).sections[0]?.path).toBe('my file.ts')
  })

  it('reads a mode change without content from the header', () => {
    const modeOnly = 'diff --git a/bin/run b/bin/run\nold mode 100644\nnew mode 100755\n'

    expect(splitDiff(modeOnly).sections[0]?.path).toBe('bin/run')
  })

  it('keeps text before the first file as the preamble', () => {
    expect(splitDiff(`note\n${MODIFIED}`).preamble).toBe('note\n')
    expect(splitDiff('').sections).toEqual([])
  })
})
