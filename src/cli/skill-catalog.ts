import type { SkillCatalog } from '../app/review-passes.js'
import type { LocalFileSystem } from '../config/local-files.js'
import type { NativeSkillRef } from '../providers/types.js'
import { listInstalledSkills } from '../skills/installed-skills.js'
import type { InstalledSkill, SkillListing } from '../skills/installed-skills.js'
import { resolveSkill } from '../skills/resolve-skill.js'
import { skillRoots } from '../skills/skill-locations.js'
import { readSkillText } from '../skills/skill-text.js'

const BUILT_IN_PREFIX = 'claude:'
const CLAUDE_PLUGIN_WARNING =
  'A plugin named claude cannot be used: claude: names skills built into Claude Code.'

export function diskSkillCatalog(
  files: LocalFileSystem,
  env: NodeJS.ProcessEnv,
  home: string,
): SkillCatalog {
  let listing: Promise<SkillListing> | undefined
  const list = () => (listing ??= listInstalledSkills(files, skillRoots(env, home)))
  return {
    find: async (name) => {
      if (name.startsWith(BUILT_IN_PREFIX)) {
        const invoke = name.slice(BUILT_IN_PREFIX.length)
        const shadowed = await hasClaudePlugin(list)
        return {
          name,
          origin: 'Claude Code',
          text: `Skill built into Claude Code: ${invoke}.`,
          omitted: [],
          native: { kind: 'builtin', invoke },
          ...(shadowed ? { warnings: [CLAUDE_PLUGIN_WARNING] } : {}),
        }
      }
      const skill = resolveSkill(name, await list())
      const { text, omitted } = await readSkillText(files, skill)
      return { name, origin: skill.path, text, omitted, native: nativeRef(skill) }
    },
  }
}

async function hasClaudePlugin(list: () => Promise<SkillListing>): Promise<boolean> {
  try {
    const { skills } = await list()
    return skills.some(
      (skill) => skill.root === 'claude-plugin' && skill.qualified.startsWith(BUILT_IN_PREFIX),
    )
  } catch {
    return false
  }
}

function nativeRef(skill: InstalledSkill): NativeSkillRef {
  if (skill.pluginDir !== undefined) {
    return {
      kind: 'plugin',
      pluginDir: skill.pluginDir,
      invoke: `${skill.pluginName ?? skill.qualified.split(':')[0]}:${skill.name}`,
    }
  }
  return { kind: 'file', fileKind: skill.kind, path: skill.path, dir: skill.dir, name: skill.name }
}
