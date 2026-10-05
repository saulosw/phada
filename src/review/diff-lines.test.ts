import { describe, expect, it } from 'vitest'
import { annotateDiff, findDiffFile, parseDiffFiles } from './diff-lines.js'
import type { DiffFile } from './diff-lines.js'

function diffOf(...lines: string[]): string {
  return `${lines.join('\n')}\n`
}

const MODIFIED = diffOf(
  'diff --git a/src/shop.ts b/src/shop.ts',
  'index 1111111..2222222 100644',
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

const ADDED = diffOf(
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+export const a = 1',
  '+export const b = 2',
)

const DELETED = diffOf(
  'diff --git a/src/old.ts b/src/old.ts',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/src/old.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-export const a = 1',
  '-export const b = 2',
)

const RENAMED = diffOf(
  'diff --git a/src/before.ts b/src/after.ts',
  'similarity index 90%',
  'rename from src/before.ts',
  'rename to src/after.ts',
  'index 5555555..6666666 100644',
  '--- a/src/before.ts',
  '+++ b/src/after.ts',
  '@@ -3 +3 @@',
  '-export const name = 1',
  '+export const name = 2',
)

const BINARY = diffOf(
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index 7777777..8888888 100644',
  'Binary files a/assets/logo.png and b/assets/logo.png differ',
)

function linesOf(file: DiffFile | undefined): number[] {
  return [...(file?.lines ?? [])]
}

describe('parseDiffFiles', () => {
  it('lists the new-file lines inside every hunk of a modified file', () => {
    const [file] = parseDiffFiles(MODIFIED)

    expect(file).toMatchObject({ path: 'src/shop.ts', status: 'modified' })
    expect(linesOf(file)).toEqual([1, 2, 3, 4, 5, 21, 22, 23])
  })

  it('reads added, deleted, renamed and binary files', () => {
    const files = parseDiffFiles(MODIFIED + ADDED + DELETED + RENAMED + BINARY)

    expect(files.map(({ path, status }) => `${status} ${path}`)).toEqual([
      'modified src/shop.ts',
      'added src/new.ts',
      'deleted src/old.ts',
      'renamed src/after.ts',
      'binary assets/logo.png',
    ])
    expect(linesOf(files[1])).toEqual([1, 2])
    expect(linesOf(files[2])).toEqual([])
    expect(linesOf(files[3])).toEqual([3])
    expect(linesOf(files[4])).toEqual([])
  })

  it('keeps a renamed file without changes, with no lines', () => {
    const files = parseDiffFiles(
      diffOf(
        'diff --git a/a.ts b/b.ts',
        'similarity index 100%',
        'rename from a.ts',
        'rename to b.ts',
      ),
    )

    expect(files).toEqual([{ path: 'b.ts', status: 'renamed', lines: new Set() }])
  })

  it('takes a deleted file path from its old side when the folder name has " b/"', () => {
    const [file] = parseDiffFiles(
      diffOf(
        'diff --git a/docs/sub b/old.md b/docs/sub b/old.md',
        'deleted file mode 100644',
        '--- a/docs/sub b/old.md',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-gone',
      ),
    )

    expect(file).toMatchObject({ path: 'docs/sub b/old.md', status: 'deleted' })
  })

  it('drops the tab git writes after a path that has a space', () => {
    const files = parseDiffFiles(
      diffOf(
        'diff --git a/docs/my file.md b/docs/my file.md',
        '--- a/docs/my file.md\t',
        '+++ b/docs/my file.md\t',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        'diff --git "a/minha a\\303\\247\\303\\243o.ts" "b/minha a\\303\\247\\303\\243o.ts"',
        '--- "a/minha a\\303\\247\\303\\243o.ts"\t',
        '+++ "b/minha a\\303\\247\\303\\243o.ts"\t',
        '@@ -1 +1 @@',
        '-x',
        '+y',
      ),
    )

    expect(files.map(({ path }) => path)).toEqual(['docs/my file.md', 'minha ação.ts'])
  })

  it('does not count the no-newline marker as a line', () => {
    const [file] = parseDiffFiles(
      diffOf(
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1 +1,2 @@',
        '-old',
        '\\ No newline at end of file',
        '+new',
        '+last',
        '\\ No newline at end of file',
      ),
    )

    expect(linesOf(file)).toEqual([1, 2])
  })

  it('treats removed and added lines that look like file headers as content', () => {
    const [file, second] = parseDiffFiles(
      diffOf(
        'diff --git a/q.sql b/q.sql',
        '--- a/q.sql',
        '+++ b/q.sql',
        '@@ -1,2 +1,2 @@',
        '--- old comment',
        '+++ new comment',
        ' select 1',
        'diff --git a/r.sql b/r.sql',
        '--- a/r.sql',
        '+++ b/r.sql',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ),
    )

    expect(file).toMatchObject({ path: 'q.sql', status: 'modified' })
    expect(linesOf(file)).toEqual([1, 2])
    expect(second?.path).toBe('r.sql')
  })

  it('decodes quoted paths with non-ASCII characters', () => {
    const [file] = parseDiffFiles(
      diffOf(
        'diff --git "a/src/a\\303\\247\\303\\243o.ts" "b/src/a\\303\\247\\303\\243o.ts"',
        '--- "a/src/a\\303\\247\\303\\243o.ts"',
        '+++ "b/src/a\\303\\247\\303\\243o.ts"',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ),
    )

    expect(file?.path).toBe('src/ação.ts')
  })

  it('returns nothing for an empty diff', () => {
    expect(parseDiffFiles('')).toEqual([])
  })
})

describe('annotateDiff', () => {
  it('numbers added and context lines with their line in the new file', () => {
    expect(annotateDiff(MODIFIED)).toBe(
      diffOf(
        'diff --git a/src/shop.ts b/src/shop.ts',
        'index 1111111..2222222 100644',
        '--- a/src/shop.ts',
        '+++ b/src/shop.ts',
        '@@ -1,4 +1,5 @@',
        "    1  import { db } from './db'",
        '      -const LIMIT = 10',
        '    2 +const LIMIT = 20',
        '    3 +const FEE = 1',
        '    4  ',
        '    5  export function spend() {',
        '@@ -20,3 +21,3 @@ export function spend() {',
        '   21    const user = db.find()',
        '      -  return user',
        '   22 +  return { user }',
        '   23  }',
      ),
    )
  })

  it('leaves headers, deleted files and binary files without numbers', () => {
    expect(annotateDiff(DELETED + BINARY)).toBe(
      diffOf(
        'diff --git a/src/old.ts b/src/old.ts',
        'deleted file mode 100644',
        'index 4444444..0000000',
        '--- a/src/old.ts',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '      -export const a = 1',
        '      -export const b = 2',
        'diff --git a/assets/logo.png b/assets/logo.png',
        'index 7777777..8888888 100644',
        'Binary files a/assets/logo.png and b/assets/logo.png differ',
      ),
    )
  })

  it('aligns the no-newline marker with removed lines', () => {
    expect(
      annotateDiff(diffOf('@@ -1 +1 @@', '-old', '+new', '\\ No newline at end of file')),
    ).toBe(diffOf('@@ -1 +1 @@', '      -old', '    1 +new', '      \\ No newline at end of file'))
  })

  it('returns an empty diff unchanged', () => {
    expect(annotateDiff('')).toBe('')
  })
})

describe('findDiffFile', () => {
  const files = parseDiffFiles(
    MODIFIED +
      ADDED +
      diffOf('diff --git a/api/users.ts b/api/users.ts', '@@ -1 +1 @@', '-a', '+b') +
      diffOf('diff --git a/web/users.ts b/web/users.ts', '@@ -1 +1 @@', '-a', '+b'),
  )

  it.each([
    ['src/shop.ts', 'src/shop.ts'],
    ['./src/shop.ts', 'src/shop.ts'],
    ['a/src/shop.ts', 'src/shop.ts'],
    ['b/src/new.ts', 'src/new.ts'],
    ['/src/new.ts', 'src/new.ts'],
    ['shop.ts', 'src/shop.ts'],
    ['api/users.ts', 'api/users.ts'],
  ])('finds %s as %s', (path, expected) => {
    expect(findDiffFile(path, files)?.path).toBe(expected)
  })

  it.each(['users.ts', 'hop.ts', 'src/other.ts', ''])(
    'finds no file for %j, which is missing or ambiguous',
    (path) => {
      expect(findDiffFile(path, files)).toBeUndefined()
    },
  )
})
