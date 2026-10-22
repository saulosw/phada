import { SkillError } from './errors.js'
import type { InstalledSkill, SkillListing } from './installed-skills.js'

export function resolveSkill(name: string, listing: SkillListing): InstalledSkill {
  const { skills } = listing
  if (name.includes(':')) {
    const plugin = skills.find(
      (skill) => skill.root === 'claude-plugin' && skill.qualified === name,
    )
    if (plugin !== undefined) return plugin
    throw notInstalled(name, listing)
  }
  const own = skills.find((skill) => skill.root !== 'claude-plugin' && skill.name === name)
  if (own !== undefined) return own
  const plugins = skills.filter((skill) => skill.root === 'claude-plugin' && skill.name === name)
  if (plugins.length === 1 && plugins[0] !== undefined) return plugins[0]
  if (plugins.length > 1) {
    const names = plugins.map((skill) => skill.qualified).join(', ')
    throw new SkillError(
      `Skill "${name}" matches several plugins: ${names}. Use one of these names.`,
    )
  }
  throw notInstalled(name, listing)
}

function notInstalled(name: string, { searched, warnings }: SkillListing): SkillError {
  const notes = warnings.length === 0 ? '' : ` ${warnings.join(' ')}`
  return new SkillError(
    `Skill "${name}" is not installed. Phada looked in ${searched.join(', ')}.${notes}`,
  )
}
