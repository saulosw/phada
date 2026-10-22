import { describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import type { InstalledSkill } from './installed-skills.js'
import { readSkillText, SKILL_TEXT_LIMIT_BYTES } from './skill-text.js'

const DIR = '/s/requesting-code-review'
const skill: InstalledSkill = {
  name: 'requesting-code-review',
  qualified: 'sp:requesting-code-review',
  kind: 'skill',
  root: 'claude-plugin',
  path: `${DIR}/SKILL.md`,
  dir: DIR,
}

describe('readSkillText', () => {
  it('drops the front matter and adds the files the skill cites', async () => {
    const files = memoryFiles({
      [`${DIR}/SKILL.md`]: '---\nname: x\n---\n\nUse the template at code-reviewer.md.',
      [`${DIR}/code-reviewer.md`]: 'Check correctness.',
      [`${DIR}/unused.md`]: 'Not cited.',
    })

    const text = await readSkillText(files, skill)

    expect(text.text).toBe(
      'Use the template at code-reviewer.md.\n\n=== code-reviewer.md ===\nCheck correctness.',
    )
    expect(text.included).toEqual(['code-reviewer.md'])
    expect(text.omitted).toEqual([])
  })

  it('strips a CRLF front matter with BOM', async () => {
    const files = memoryFiles({ [`${DIR}/SKILL.md`]: '﻿---\r\nname: x\r\n---\r\nBody.\r\n' })

    expect((await readSkillText(files, skill)).text).toBe('Body.')
  })

  it('reads only cited files inside the skill folder', async () => {
    const files = memoryFiles({
      [`${DIR}/SKILL.md`]: 'See ../x.md, /etc/p.md, https://h/a.md and SKILL.md.',
      '/s/x.md': 'outside',
      '/etc/p.md': 'secret',
    })

    const text = await readSkillText(files, skill)

    expect(text.included).toEqual([])
    expect(text.text).not.toContain('outside')
    expect(text.text).not.toContain('secret')
  })

  it('leaves out a cited file that does not fit', async () => {
    const files = memoryFiles({
      [`${DIR}/SKILL.md`]: 'Read big.md and small.md.',
      [`${DIR}/big.md`]: 'x'.repeat(SKILL_TEXT_LIMIT_BYTES),
      [`${DIR}/small.md`]: 'small',
    })

    const text = await readSkillText(files, skill)

    expect(text.included).toEqual(['small.md'])
    expect(text.omitted).toEqual(['big.md'])
    expect(text.bytes).toBeLessThanOrEqual(SKILL_TEXT_LIMIT_BYTES)
  })

  it('refuses a SKILL.md larger than the limit', async () => {
    const files = memoryFiles({ [`${DIR}/SKILL.md`]: 'x'.repeat(SKILL_TEXT_LIMIT_BYTES + 1) })

    await expect(readSkillText(files, skill)).rejects.toThrow(
      `Skill "sp:requesting-code-review" (${DIR}/SKILL.md) is larger than 32 KB.`,
    )
  })

  it('refuses a skill with only a front matter', async () => {
    const files = memoryFiles({ [`${DIR}/SKILL.md`]: '---\nname: x\n---\n\n' })

    await expect(readSkillText(files, skill)).rejects.toThrow(
      `Skill "sp:requesting-code-review" (${DIR}/SKILL.md) is empty.`,
    )
  })

  it('never adds sibling files to a command', async () => {
    const files = memoryFiles({
      '/c/commands/review.md': 'Like other.md.',
      '/c/commands/other.md': 'Other command.',
    })
    const command: InstalledSkill = {
      name: 'review',
      qualified: 'review',
      kind: 'command',
      root: 'claude',
      path: '/c/commands/review.md',
      dir: '/c/commands',
    }

    expect((await readSkillText(files, command)).text).toBe('Like other.md.')
  })
})

describe('readSkillText of a file that disappeared', () => {
  it('says the skill could not be read', async () => {
    await expect(readSkillText(memoryFiles({}), skill)).rejects.toThrow(
      `Skill "sp:requesting-code-review" (${DIR}/SKILL.md) could not be read.`,
    )
  })
})
