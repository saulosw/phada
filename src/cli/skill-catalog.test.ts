import { describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { SkillError } from '../skills/errors.js'
import { diskSkillCatalog } from './skill-catalog.js'

describe('diskSkillCatalog', () => {
  it('finds an installed skill and reads its text', async () => {
    const files = memoryFiles({
      '/home/u/.claude/skills/sec/SKILL.md': '---\nname: security-review\n---\nCheck auth.',
    })

    const skill = await diskSkillCatalog(files, {}, '/home/u').find('security-review')

    expect(skill).toEqual({
      name: 'security-review',
      origin: '/home/u/.claude/skills/sec/SKILL.md',
      text: 'Check auth.',
      omitted: [],
    })
  })

  it('lists the installed skills once for several lookups', async () => {
    const files = memoryFiles({ '/home/u/.claude/skills/a/SKILL.md': 'A.' })
    let listed = 0
    const counting = {
      ...files,
      listDir: async (path: string) => {
        if (path === '/home/u/.claude/skills') listed += 1
        return files.listDir(path)
      },
    }
    const catalog = diskSkillCatalog(counting, {}, '/home/u')

    await catalog.find('a')
    await catalog.find('a')

    expect(listed).toBe(1)
  })

  it('fails with a SkillError for a missing skill', async () => {
    await expect(diskSkillCatalog(memoryFiles({}), {}, '/home/u').find('x')).rejects.toThrow(
      SkillError,
    )
  })
})
