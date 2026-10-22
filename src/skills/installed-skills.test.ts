import { describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { listInstalledSkills } from './installed-skills.js'
import { skillRoots } from './skill-locations.js'

const roots = skillRoots({}, '/home/u')
const PLUGINS = '/home/u/.claude/plugins'

function installed(plugins: Record<string, string>): string {
  return JSON.stringify({
    version: 2,
    plugins: Object.fromEntries(
      Object.entries(plugins).map(([key, installPath]) => [key, [{ scope: 'user', installPath }]]),
    ),
  })
}

describe('skillRoots', () => {
  it('uses the home folders by default', () => {
    expect(skillRoots({}, '/home/u')).toEqual({
      claude: '/home/u/.claude',
      codex: '/home/u/.codex',
      agents: '/home/u/.agents',
    })
  })

  it('follows CLAUDE_CONFIG_DIR and CODEX_HOME', () => {
    expect(skillRoots({ CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: ' /x ' }, '/home/u')).toMatchObject({
      claude: '/c',
      codex: '/x',
    })
  })
})

describe('listInstalledSkills', () => {
  it('finds user skills and commands, Codex skills and shared agent skills', async () => {
    const files = memoryFiles({
      '/home/u/.claude/skills/sec/SKILL.md': '---\nname: security-review\n---\nCheck auth.',
      '/home/u/.claude/skills/plain/SKILL.md': 'No front matter.',
      '/home/u/.claude/commands/quick.md': 'Look for bugs.',
      '/home/u/.codex/skills/style/SKILL.md': 'Style.',
      '/home/u/.codex/skills/.system/hidden/SKILL.md': 'Hidden.',
      '/home/u/.agents/skills/shared/SKILL.md': 'Shared.',
    })

    const listing = await listInstalledSkills(files, roots)

    expect(listing.skills.map(({ qualified, kind, root }) => [qualified, kind, root])).toEqual([
      ['plain', 'skill', 'claude'],
      ['security-review', 'skill', 'claude'],
      ['quick', 'command', 'claude'],
      ['style', 'skill', 'codex'],
      ['shared', 'skill', 'agents'],
    ])
    expect(listing.skills[1]).toMatchObject({
      path: '/home/u/.claude/skills/sec/SKILL.md',
      dir: '/home/u/.claude/skills/sec',
    })
    expect(listing.searched).toEqual([
      '/home/u/.claude/skills',
      '/home/u/.claude/commands',
      '/home/u/.claude/plugins/installed_plugins.json',
      '/home/u/.codex/skills',
      '/home/u/.agents/skills',
    ])
  })

  it('finds plugin skills listed in plugin.json and plugin commands', async () => {
    const files = memoryFiles({
      [`${PLUGINS}/installed_plugins.json`]: installed({
        'pocock@market': `${PLUGINS}/cache/market/pocock/1.3.1`,
        'code-review@market': `${PLUGINS}/cache/market/code-review/af59`,
      }),
      [`${PLUGINS}/cache/market/pocock/1.3.1/.claude-plugin/plugin.json`]: JSON.stringify({
        name: 'pocock',
        skills: ['./skills/engineering/code-review', '../../outside'],
      }),
      [`${PLUGINS}/cache/market/pocock/1.3.1/skills/engineering/code-review/SKILL.md`]:
        '---\nname: code-review\n---\nTwo axes.',
      [`${PLUGINS}/cache/market/pocock/1.3.1/skills/other/SKILL.md`]: 'In the default folder.',
      [`${PLUGINS}/cache/market/outside/SKILL.md`]: 'Outside.',
      [`${PLUGINS}/cache/market/code-review/af59/commands/code-review.md`]: 'Five agents.',
    })

    const listing = await listInstalledSkills(files, roots)

    expect(listing.skills.map(({ qualified, kind }) => [qualified, kind])).toEqual([
      ['code-review:code-review', 'command'],
      ['pocock:code-review', 'skill'],
      ['pocock:other', 'skill'],
    ])
  })

  it('reads skills/*/SKILL.md of a plugin without a skills list', async () => {
    const files = memoryFiles({
      [`${PLUGINS}/installed_plugins.json`]: installed({ 'sp@m': `${PLUGINS}/cache/m/sp/7.0.0` }),
      [`${PLUGINS}/cache/m/sp/7.0.0/.claude-plugin/plugin.json`]: '{"name":"sp"}',
      [`${PLUGINS}/cache/m/sp/7.0.0/skills/requesting-code-review/SKILL.md`]: 'Dispatch.',
    })

    const listing = await listInstalledSkills(files, roots)

    expect(listing.skills.map(({ qualified }) => qualified)).toEqual(['sp:requesting-code-review'])
  })

  it('ignores orphaned plugin versions', async () => {
    const files = memoryFiles({
      [`${PLUGINS}/installed_plugins.json`]: installed({ 'sp@m': `${PLUGINS}/cache/m/sp/7.0.0` }),
      [`${PLUGINS}/cache/m/sp/7.0.0/skills/review/SKILL.md`]: 'New.',
      [`${PLUGINS}/cache/m/sp/6.0.0/skills/review/SKILL.md`]: 'Old.',
      [`${PLUGINS}/cache/m/sp/6.0.0/.orphaned_at`]: '1',
    })

    const listing = await listInstalledSkills(files, roots)

    expect(listing.skills.map(({ path }) => path)).toEqual([
      `${PLUGINS}/cache/m/sp/7.0.0/skills/review/SKILL.md`,
    ])
  })

  it('warns and searches no plugin when installed_plugins.json is invalid', async () => {
    const files = memoryFiles({ [`${PLUGINS}/installed_plugins.json`]: '{not json' })

    const listing = await listInstalledSkills(files, roots)

    expect(listing.skills).toEqual([])
    expect(listing.warnings).toEqual([
      `Could not read ${PLUGINS}/installed_plugins.json: plugin skills were not searched.`,
    ])
  })
})

describe('listInstalledSkills with the plugin manifest forms', () => {
  const ROOT = `${PLUGINS}/cache/m/p/1.0.0`
  const withPlugin = (files: Record<string, string>) =>
    memoryFiles({
      [`${PLUGINS}/installed_plugins.json`]: installed({ 'p@m': ROOT }),
      ...files,
    })
  const names = async (files: Record<string, string>) =>
    (await listInstalledSkills(withPlugin(files), roots)).skills.map(({ qualified }) => qualified)

  it('scans a listed folder of skills and still scans skills/', async () => {
    expect(
      await names({
        [`${ROOT}/.claude-plugin/plugin.json`]: '{"name":"p","skills":["./extra-skills/"]}',
        [`${ROOT}/extra-skills/a/SKILL.md`]: 'A.',
        [`${ROOT}/extra-skills/b/SKILL.md`]: 'B.',
        [`${ROOT}/skills/c/SKILL.md`]: 'C.',
      }),
    ).toEqual(['p:a', 'p:b', 'p:c'])
  })

  it('reads the plugin root as a skill folder when the manifest lists it', async () => {
    expect(
      await names({
        [`${ROOT}/.claude-plugin/plugin.json`]: '{"name":"p","skills":"./"}',
        [`${ROOT}/SKILL.md`]: '---\nname: root-review\n---\nRoot.',
      }),
    ).toEqual(['p:root-review'])
  })

  it('loads a plugin with SKILL.md at its root and no skills folder as one skill', async () => {
    expect(await names({ [`${ROOT}/SKILL.md`]: 'Root.' })).toEqual(['p:p'])
  })

  it('lists a skill folder only once when the manifest also names skills/', async () => {
    expect(
      await names({
        [`${ROOT}/.claude-plugin/plugin.json`]: '{"name":"p","skills":["./skills/"]}',
        [`${ROOT}/skills/c/SKILL.md`]: 'C.',
      }),
    ).toEqual(['p:c'])
  })

  it('reads commands given as files and as a map, instead of commands/', async () => {
    expect(
      await names({
        [`${ROOT}/.claude-plugin/plugin.json`]: JSON.stringify({
          name: 'p',
          commands: {
            status: { source: './cmds/status.md' },
            about: { content: 'Inline.' },
          },
        }),
        [`${ROOT}/cmds/status.md`]: 'Status.',
        [`${ROOT}/commands/ignored.md`]: 'Ignored.',
      }),
    ).toEqual(['p:status'])
    expect(
      await names({
        [`${ROOT}/.claude-plugin/plugin.json`]: '{"name":"p","commands":["./cmds/review.md"]}',
        [`${ROOT}/cmds/review.md`]: 'Review.',
      }),
    ).toEqual(['p:review'])
  })

  it('takes the name of a skill from a CRLF front matter with BOM', async () => {
    const files = memoryFiles({
      '/home/u/.claude/skills/sec/SKILL.md': '\uFEFF---\r\nname: security-review\r\n---\r\nBody.',
    })

    expect((await listInstalledSkills(files, roots)).skills[0]?.name).toBe('security-review')
  })
})
