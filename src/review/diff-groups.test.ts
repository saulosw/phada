import { describe, expect, it } from 'vitest'
import { groupDiff, planDiffGroups } from './diff-groups.js'

const LINE = `${'x'.repeat(99)}\n`

function newFile(path: string, kb: number, header?: string): string {
  const lines = Math.max(1, Math.round((kb * 1000) / 101))
  const body = [
    ...(header === undefined ? [] : [`+${header}`]),
    ...Array.from({ length: lines }, () => `+${LINE.trimEnd()}`),
  ]
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${body.length} @@`,
    ...body,
    '',
  ].join('\n')
}

function diffOf(files: Record<string, number>): string {
  return Object.entries(files)
    .map(([path, kb]) => newFile(path, kb))
    .join('')
}

function shape(groups: ReturnType<typeof planDiffGroups>) {
  return groups?.map(({ label, files, link }) => ({ label, files, link }))
}

describe('planDiffGroups', () => {
  it('leaves a diff under 30 KB of code in one piece', () => {
    expect(planDiffGroups(diffOf({ 'api/a.ts': 6, 'web/b.ts': 4 }))).toBeUndefined()
  })

  it('groups a 62 KB diff by its four directories', () => {
    const groups = planDiffGroups(
      diffOf({
        'api/services/user.ts': 9,
        'api/services/season.ts': 8,
        'api/repositories/user.ts': 7,
        'api/repositories/season.ts': 8,
        'web/hooks/use-board.ts': 8,
        'web/hooks/use-user.ts': 7,
        'web/pages/board.tsx': 8,
        'web/pages/home.tsx': 7,
      }),
    )
    expect(shape(groups)).toEqual([
      {
        label: 'api/repositories',
        files: ['api/repositories/user.ts', 'api/repositories/season.ts'],
        link: 'directory',
      },
      {
        label: 'api/services',
        files: ['api/services/user.ts', 'api/services/season.ts'],
        link: 'directory',
      },
      {
        label: 'web/hooks',
        files: ['web/hooks/use-board.ts', 'web/hooks/use-user.ts'],
        link: 'directory',
      },
      {
        label: 'web/pages',
        files: ['web/pages/board.tsx', 'web/pages/home.tsx'],
        link: 'directory',
      },
    ])
    for (const group of groups ?? []) {
      expect(group.bytes).toBeGreaterThan(13_000)
      expect(group.bytes).toBeLessThanOrEqual(20_000)
    }
  })

  it('keeps a directory that fits the cap as one group', () => {
    expect(
      shape(planDiffGroups(diffOf({ 'api/a.ts': 9, 'api/b.ts': 9, 'web/c.ts': 9, 'web/d.ts': 9 }))),
    ).toEqual([
      { label: 'api', files: ['api/a.ts', 'api/b.ts'], link: 'directory' },
      { label: 'web', files: ['web/c.ts', 'web/d.ts'], link: 'directory' },
    ])
  })

  it('packs the loose files of a directory over the cap in order, in numbered parts', () => {
    expect(
      shape(planDiffGroups(diffOf({ 'src/a.ts': 8, 'src/b.ts': 8, 'src/c.ts': 8, 'src/d.ts': 8 }))),
    ).toEqual([
      { label: 'src (part 1)', files: ['src/a.ts', 'src/b.ts'], link: 'directory' },
      { label: 'src (part 2)', files: ['src/c.ts', 'src/d.ts'], link: 'directory' },
    ])
  })

  it('makes a file larger than the cap a group of its own', () => {
    expect(shape(planDiffGroups(diffOf({ 'src/big.ts': 26, 'src/small.ts': 6 })))).toEqual([
      { label: 'src/big.ts', files: ['src/big.ts'], link: 'single' },
      { label: 'src', files: ['src/small.ts'], link: 'directory' },
    ])
  })

  it('joins small sibling directories while they fit the cap', () => {
    expect(
      shape(
        planDiffGroups(
          diffOf({
            'app/a/one.ts': 4,
            'app/b/two.ts': 4,
            'app/c/three.ts': 4,
            'app/d/four.ts': 15,
            'lib/x.ts': 9,
          }),
        ),
      ),
    ).toEqual([
      {
        label: 'app',
        files: ['app/a/one.ts', 'app/b/two.ts', 'app/c/three.ts'],
        link: 'directory',
      },
      { label: 'app/d', files: ['app/d/four.ts'], link: 'directory' },
      { label: 'lib', files: ['lib/x.ts'], link: 'directory' },
    ])
  })

  it('names a group that joins different top directories after each of them', () => {
    expect(
      shape(
        planDiffGroups(
          diffOf({
            'api/prisma/schema.prisma': 7,
            'api/src/services/ranking.ts': 9,
            'api/src/routes/ranking.ts': 7,
            'functions/src/index.ts': 2,
            'web/a.ts': 16,
          }),
        ),
      )?.map(({ label }) => label),
    ).toEqual(['api/prisma', 'api/src + functions/src', 'web'])
  })

  it('leaves data files out of the threshold and reviews them with the nearest group', () => {
    const diff = diffOf({
      'api/a.ts': 9,
      'web/b.ts': 9,
      'api/migrations/meta/0004_snapshot.json': 40,
    })
    expect(planDiffGroups(diff)).toBeUndefined()
    expect(
      shape(
        planDiffGroups(
          diffOf({
            'api/a.ts': 16,
            'web/b.ts': 16,
            'api/migrations/meta/0004_snapshot.json': 40,
            'web/public/data.csv': 5,
          }),
        ),
      ),
    ).toEqual([
      {
        label: 'api',
        files: ['api/a.ts', 'api/migrations/meta/0004_snapshot.json'],
        link: 'directory',
      },
      { label: 'web', files: ['web/b.ts', 'web/public/data.csv'], link: 'directory' },
    ])
  })

  it('leaves out the files marked as generated and the ones with a generated header', () => {
    const marked = diffOf({ 'api/a.ts': 16, 'web/b.ts': 9, 'web/schema.ts': 30 })
    expect(planDiffGroups(marked, ['web/schema.ts'])).toBeUndefined()
    expect(shape(planDiffGroups(marked))).toHaveLength(3)

    const withHeader =
      diffOf({ 'api/a.ts': 16, 'web/b.ts': 9 }) +
      newFile('web/client.go', 30, '// Code generated by protoc-gen-go. DO NOT EDIT.') +
      newFile('web/types.ts', 30, '/* @generated */')
    expect(planDiffGroups(withHeader)).toBeUndefined()
  })

  it('leaves deleted files out of the threshold and reviews them with the nearest group', () => {
    const lines = Math.round(40_000 / 101)
    const deleted = [
      'diff --git a/legacy/old.ts b/legacy/old.ts',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/legacy/old.ts',
      '+++ /dev/null',
      `@@ -1,${lines} +0,0 @@`,
      ...Array.from({ length: lines }, () => `-${LINE.trimEnd()}`),
      '',
    ].join('\n')
    expect(planDiffGroups(diffOf({ 'api/a.ts': 9, 'web/b.ts': 9 }) + deleted)).toBeUndefined()
    const groups = planDiffGroups(diffOf({ 'api/a.ts': 16, 'web/b.ts': 16 }) + deleted)
    expect(shape(groups)).toEqual([
      { label: 'api', files: ['api/a.ts', 'legacy/old.ts'], link: 'directory' },
      { label: 'web', files: ['web/b.ts'], link: 'directory' },
    ])
  })

  it('merges the smallest groups into their nearest neighbour above six groups', () => {
    const groups = planDiffGroups(
      diffOf({
        'a/one.ts': 15,
        'b/two.ts': 15,
        'c/three.ts': 15,
        'd/four.ts': 15,
        'e/five.ts': 15,
        'f/six.ts': 15,
        'g/seven.ts': 15,
        'g/h/eight.ts': 3,
        'i/nine.ts': 4,
      }),
    )
    expect(groups).toHaveLength(6)
    expect(shape(groups)?.flatMap(({ files }) => files)).toHaveLength(9)
    expect(shape(groups)?.find(({ files }) => files.includes('g/h/eight.ts'))?.files).toContain(
      'g/seven.ts',
    )
  })

  it('does not group when everything lands in one group', () => {
    expect(planDiffGroups(diffOf({ 'src/huge.ts': 45 }))).toBeUndefined()
  })
})

describe('groupDiff', () => {
  it('keeps only the sections of the files of the group', () => {
    const diff = diffOf({ 'api/a.ts': 1, 'web/b.ts': 1, 'api/c.ts': 1 })
    const part = groupDiff(diff, ['api/a.ts', 'api/c.ts'])
    expect(part).toContain('+++ b/api/a.ts')
    expect(part).toContain('+++ b/api/c.ts')
    expect(part).not.toContain('web/b.ts')
  })
})
