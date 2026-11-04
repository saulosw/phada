import { describe, expect, it } from 'vitest'
import {
  LOW_COVERAGE_BELOW_PERCENT,
  measureCoverage,
  NEW_FILE_COMPARED_FROM_LINES,
} from './coverage.js'
import { parseDiffFiles } from './diff-lines.js'
import type { FileCheck, FileDeclaration } from './types.js'

function modified(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,1 +1,2 @@',
    ' keep',
    '+added',
  ].join('\n')
}

function created(path: string, lines: number): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines} @@`,
    ...Array.from({ length: lines }, (_, index) => `+line ${index + 1}`),
  ].join('\n')
}

function declared(
  path: string,
  checked: FileCheck = 'diff',
  against: string | null = null,
  change = '',
): FileDeclaration {
  return { path, checked, against, change }
}

function coverageOf(
  diff: readonly string[],
  declarations: readonly FileDeclaration[],
  { reads = [], verified = true }: { reads?: readonly string[]; verified?: boolean } = {},
) {
  return measureCoverage({
    files: parseDiffFiles(diff.join('\n')),
    declarations,
    reads: new Set(reads),
    verified,
  })
}

describe('measureCoverage', () => {
  it('is full when every file of the diff is accounted for from the diff', () => {
    expect(
      coverageOf(
        [modified('src/a.ts'), modified('src/b.ts')],
        [declared('src/a.ts'), declared('src/b.ts')],
      ),
    ).toEqual({
      level: 'full',
      covered: 2,
      total: 2,
      declaredOnly: 0,
      skipped: 0,
      gaps: [],
      verified: true,
      reason: 'every file accounted for',
    })
  })

  it('is low for 11 of 63 files accounted for, with the missing files as gaps', () => {
    const paths = Array.from({ length: 63 }, (_, index) => `src/f${index}.ts`)

    const coverage = coverageOf(
      paths.map(modified),
      paths.slice(0, 11).map((path) => declared(path)),
    )

    expect(coverage).toMatchObject({
      level: 'low',
      covered: 11,
      total: 63,
      reason: '52 files not accounted for',
    })
    expect(coverage.gaps).toHaveLength(52)
    expect(coverage.gaps[0]).toEqual({ path: 'src/f11.ts', kind: 'missing' })
  })

  it.each([
    [7, 'partial'],
    [6, 'low'],
    [10, 'full'],
  ])(
    `with %i of 10 files covered is %s (low below ${LOW_COVERAGE_BELOW_PERCENT}%%)`,
    (covered, level) => {
      const paths = Array.from({ length: 10 }, (_, index) => `f${index}.ts`)

      expect(
        coverageOf(
          paths.map(modified),
          paths.slice(0, covered).map((path) => declared(path)),
        ).level,
      ).toBe(level)
    },
  )

  it('leaves binary files out of the total and the gaps', () => {
    const binary = [
      'diff --git a/img/logo.png b/img/logo.png',
      'index 1111111..2222222 100644',
      'Binary files a/img/logo.png and b/img/logo.png differ',
    ].join('\n')

    expect(coverageOf([modified('src/a.ts'), binary], [declared('src/a.ts')])).toMatchObject({
      level: 'full',
      covered: 1,
      total: 1,
      gaps: [],
    })
  })

  it('counts a skipped file as a gap with its reason', () => {
    const coverage = coverageOf(
      [modified('a.ts'), modified('package-lock.json')],
      [declared('a.ts'), declared('package-lock.json', 'skipped', null, 'Generated lockfile')],
    )

    expect(coverage).toMatchObject({
      level: 'low',
      covered: 1,
      skipped: 1,
      gaps: [{ path: 'package-lock.json', kind: 'skipped', reason: 'Generated lockfile' }],
      reason: '1 file skipped',
    })
  })

  it('counts a file read in full only when read_file read it, else as declared only', () => {
    const diff = [modified('a.ts'), modified('b.ts')]
    const declarations = [declared('a.ts', 'file'), declared('./b.ts', 'file')]

    expect(coverageOf(diff, declarations, { reads: ['a.ts', 'b.ts'] })).toMatchObject({
      level: 'full',
      declaredOnly: 0,
      gaps: [],
    })
    expect(coverageOf(diff, declarations, { reads: ['a.ts'] })).toMatchObject({
      level: 'full',
      covered: 2,
      declaredOnly: 1,
      gaps: [{ path: 'b.ts', kind: 'declared-only' }],
      reason: '1 file declared as read but never read',
    })
  })

  it('counts a comparison as declared only when the other path was not read', () => {
    const declarations = [declared('a.ts', 'compared', 'src/b.ts')]

    expect(
      coverageOf([modified('a.ts')], declarations, { reads: ['./src/b.ts'] }).declaredOnly,
    ).toBe(0)
    expect(coverageOf([modified('a.ts')], declarations, { reads: ['a.ts'] })).toMatchObject({
      level: 'full',
      declaredOnly: 1,
    })
    expect(
      coverageOf([modified('a.ts')], [declared('a.ts', 'compared')], { reads: ['a.ts'] })
        .declaredOnly,
    ).toBe(1)
  })

  it(`covers a new file of ${NEW_FILE_COMPARED_FROM_LINES}+ added lines only when compared with a read path outside the diff`, () => {
    const big = created('src/new.ts', NEW_FILE_COMPARED_FROM_LINES)
    const diff = [big, modified('src/old.ts')]
    const old = declared('src/old.ts')
    const comparedWith = (against: string) => [old, declared('src/new.ts', 'compared', against)]

    expect(coverageOf(diff, comparedWith('src/near.ts'), { reads: ['src/near.ts'] })).toMatchObject(
      {
        level: 'full',
        gaps: [],
      },
    )
    expect(coverageOf(diff, comparedWith('src/old.ts'), { reads: ['src/old.ts'] })).toMatchObject({
      level: 'low',
      declaredOnly: 0,
      gaps: [{ path: 'src/new.ts', kind: 'not-compared' }],
      reason: '1 new file not compared with existing code',
    })
    expect(coverageOf(diff, comparedWith('src/near.ts'))).toMatchObject({
      declaredOnly: 1,
      gaps: [{ path: 'src/new.ts', kind: 'not-compared' }],
      reason: '1 new file not compared with existing code, 1 file declared as read but never read',
    })
    expect(
      coverageOf(diff, [old, declared('src/new.ts', 'file')], { reads: ['src/new.ts'] }),
    ).toMatchObject({ gaps: [{ path: 'src/new.ts', kind: 'not-compared' }], declaredOnly: 0 })
    expect(coverageOf(diff, [old, declared('src/new.ts')]).gaps).toEqual([
      { path: 'src/new.ts', kind: 'not-compared' },
    ])
  })

  it('covers a new file compared with the file of the diff its code came from', () => {
    const big = created('src/utils/_urls.py', NEW_FILE_COMPARED_FROM_LINES)
    const deleted = [
      'diff --git a/src/utils.py b/src/utils.py',
      'deleted file mode 100644',
      '--- a/src/utils.py',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-def a(): pass',
      '-def b(): pass',
    ].join('\n')
    const shrunk = [
      'diff --git a/src/helpers.py b/src/helpers.py',
      '--- a/src/helpers.py',
      '+++ b/src/helpers.py',
      '@@ -1,2 +1,1 @@',
      ' keep',
      '-def moved(): pass',
    ].join('\n')
    const moved = (from: string) => [
      declared(from),
      declared('src/utils/_urls.py', 'compared', from),
    ]

    expect(coverageOf([big, deleted], moved('src/utils.py'))).toMatchObject({
      level: 'full',
      declaredOnly: 0,
      gaps: [],
    })
    expect(coverageOf([big, shrunk], moved('src/helpers.py'))).toMatchObject({
      level: 'full',
      declaredOnly: 0,
      gaps: [],
    })
  })

  it('covers a smaller new file from the diff', () => {
    expect(
      coverageOf(
        [created('src/new.ts', NEW_FILE_COMPARED_FROM_LINES - 1)],
        [declared('src/new.ts')],
      ).level,
    ).toBe('full')
  })

  it('ignores declarations of paths outside the diff and counts no declaration as missing', () => {
    expect(coverageOf([modified('a.ts')], [declared('elsewhere.ts')])).toMatchObject({
      level: 'low',
      covered: 0,
      total: 1,
      gaps: [{ path: 'a.ts', kind: 'missing' }],
      reason: '1 file not accounted for',
    })
  })

  it('keeps the best of several declarations of a file, as when two passes review it', () => {
    expect(
      coverageOf(
        [modified('a.ts')],
        [declared('a.ts', 'skipped', null, 'too long'), declared('a.ts', 'file'), declared('a.ts')],
      ),
    ).toMatchObject({ level: 'full', declaredOnly: 0, skipped: 0, gaps: [] })
  })

  it('takes the declarations as they are without tools: only missing and skipped files lower it', () => {
    const diff = [created('src/new.ts', 80), modified('a.ts'), modified('b.ts'), modified('c.ts')]

    expect(
      coverageOf(
        diff,
        [declared('src/new.ts'), declared('a.ts', 'file'), declared('b.ts', 'skipped')],
        { verified: false },
      ),
    ).toEqual({
      level: 'low',
      covered: 2,
      total: 4,
      declaredOnly: 0,
      skipped: 1,
      gaps: [
        { path: 'b.ts', kind: 'skipped' },
        { path: 'c.ts', kind: 'missing' },
      ],
      verified: false,
      reason: '1 file not accounted for, 1 file skipped',
    })
  })
})
