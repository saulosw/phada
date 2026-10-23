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
      native: {
        kind: 'file',
        fileKind: 'skill',
        path: '/home/u/.claude/skills/sec/SKILL.md',
        dir: '/home/u/.claude/skills/sec',
        name: 'security-review',
      },
    })
  })

  it('names a skill built into Claude Code even when the disk cannot be read', async () => {
    const files = memoryFiles({})
    const reading = {
      ...files,
      listDir: async () => {
        throw new Error('read the disk')
      },
    }

    const skill = await diskSkillCatalog(reading, {}, '/home/u').find('claude:security-review')

    expect(skill).toEqual({
      name: 'claude:security-review',
      origin: 'Claude Code',
      text: 'Skill built into Claude Code: security-review.',
      omitted: [],
      native: { kind: 'builtin', invoke: 'security-review' },
    })
  })

  it('runs a plugin skill by its plugin directory and a user command as a file', async () => {
    const plugins = '/home/u/.claude/plugins'
    const files = memoryFiles({
      [`${plugins}/installed_plugins.json`]: JSON.stringify({
        version: 2,
        plugins: { 'p@m': [{ installPath: `${plugins}/cache/p` }] },
      }),
      [`${plugins}/cache/p/.claude-plugin/plugin.json`]: '{"name":"pp"}',
      [`${plugins}/cache/p/skills/r/SKILL.md`]: 'Review.',
      '/home/u/.claude/commands/check.md': 'Check.',
    })
    const catalog = diskSkillCatalog(files, {}, '/home/u')

    expect((await catalog.find('p:r')).native).toEqual({
      kind: 'plugin',
      pluginDir: `${plugins}/cache/p`,
      invoke: 'pp:r',
    })
    expect((await catalog.find('check')).native).toMatchObject({
      kind: 'file',
      fileKind: 'command',
      name: 'check',
    })
  })

  it('warns that a plugin named claude cannot be used', async () => {
    const plugins = '/home/u/.claude/plugins'
    const files = memoryFiles({
      [`${plugins}/installed_plugins.json`]: JSON.stringify({
        version: 2,
        plugins: { 'claude@m': [{ installPath: `${plugins}/cache/c` }] },
      }),
      [`${plugins}/cache/c/skills/x/SKILL.md`]: 'X.',
    })

    const skill = await diskSkillCatalog(files, {}, '/home/u').find('claude:x')

    expect(skill.native).toEqual({ kind: 'builtin', invoke: 'x' })
    expect(skill.warnings).toEqual([
      'A plugin named claude cannot be used: claude: names skills built into Claude Code.',
    ])
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
