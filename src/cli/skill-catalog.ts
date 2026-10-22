import type { SkillCatalog } from '../app/review-passes.js'
import type { LocalFileSystem } from '../config/local-files.js'
import { listInstalledSkills } from '../skills/installed-skills.js'
import type { SkillListing } from '../skills/installed-skills.js'
import { resolveSkill } from '../skills/resolve-skill.js'
import { skillRoots } from '../skills/skill-locations.js'
import { readSkillText } from '../skills/skill-text.js'

export function diskSkillCatalog(
  files: LocalFileSystem,
  env: NodeJS.ProcessEnv,
  home: string,
): SkillCatalog {
  let listing: Promise<SkillListing> | undefined
  return {
    find: async (name) => {
      listing ??= listInstalledSkills(files, skillRoots(env, home))
      const skill = resolveSkill(name, await listing)
      const { text, omitted } = await readSkillText(files, skill)
      return { name, origin: skill.path, text, omitted }
    },
  }
}
