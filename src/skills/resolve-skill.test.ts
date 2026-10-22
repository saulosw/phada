import { describe, expect, it } from 'vitest'
import type { InstalledSkill, SkillListing } from './installed-skills.js'
import { resolveSkill } from './resolve-skill.js'
import { SkillError } from './errors.js'

function skill(qualified: string, root: InstalledSkill['root']): InstalledSkill {
  const name = qualified.split(':').at(-1) ?? qualified
  return {
    name,
    qualified,
    kind: 'skill',
    root,
    path: `/s/${qualified}/SKILL.md`,
    dir: `/s/${qualified}`,
  }
}

const listing = (skills: InstalledSkill[]): SkillListing => ({
  skills,
  searched: ['/home/u/.claude/skills', '/home/u/.codex/skills'],
  warnings: [],
})

describe('resolveSkill', () => {
  it('finds a plugin skill by its qualified name', () => {
    const found = resolveSkill(
      'p:r',
      listing([skill('q:r', 'claude-plugin'), skill('p:r', 'claude-plugin')]),
    )

    expect(found.qualified).toBe('p:r')
  })

  it('prefers the user skill to a plugin skill of the same name', () => {
    const found = resolveSkill('a', listing([skill('p:a', 'claude-plugin'), skill('a', 'codex')]))

    expect(found.qualified).toBe('a')
  })

  it('finds the only plugin skill with a bare name', () => {
    expect(resolveSkill('r', listing([skill('p:r', 'claude-plugin')])).qualified).toBe('p:r')
  })

  it('refuses a bare name that several plugins share', () => {
    const run = () =>
      resolveSkill('r', listing([skill('p:r', 'claude-plugin'), skill('q:r', 'claude-plugin')]))

    expect(run).toThrow(SkillError)
    expect(run).toThrow('Skill "r" matches several plugins: p:r, q:r. Use one of these names.')
  })

  it('says where it looked for a missing skill', () => {
    expect(() => resolveSkill('nope', listing([]))).toThrow(
      'Skill "nope" is not installed. Phada looked in /home/u/.claude/skills, /home/u/.codex/skills.',
    )
  })
})
