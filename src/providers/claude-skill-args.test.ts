import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allowedSkillTools, READ_ONLY_COMMANDS, writeSkillPlugin } from './claude-skill-args.js'

describe('allowedSkillTools', () => {
  const always = ['Read', 'Grep', 'Glob', 'Task', 'Skill']

  it('allows git reads and the gh facade in read-only', () => {
    const allowed = allowedSkillTools('read-only', [], [])

    expect(allowed.slice(0, 5)).toEqual(always)
    expect(allowed).toEqual([
      ...always,
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
      'Bash(git blame:*)',
      'Bash(git status:*)',
      'Bash(git rev-parse:*)',
      'Bash(git merge-base:*)',
      'Bash(git ls-files:*)',
      'Bash(git grep:*)',
      'Bash(gh:*)',
    ])
    expect(allowed).not.toContain('Bash')
    expect(READ_ONLY_COMMANDS).toHaveLength(10)
  })

  it('adds each listed command', () => {
    expect(allowedSkillTools(['npm test', 'make lint'], [], []).slice(-2)).toEqual([
      'Bash(npm test:*)',
      'Bash(make lint:*)',
    ])
  })

  it('allows the whole shell with all', () => {
    expect(allowedSkillTools('all', [], [])).toEqual([...always, 'Bash'])
  })

  it('allows Phada tools and the user MCP servers', () => {
    const allowed = allowedSkillTools('read-only', ['read_file', 'callers'], ['mcp__linear'])

    expect(allowed).toContain('mcp__phada__read_file')
    expect(allowed).toContain('mcp__phada__callers')
    expect(allowed).toContain('mcp__linear')
  })
})

describe('writeSkillPlugin', () => {
  let temp: string
  let skills: string

  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), 'phada-skill-args-'))
    skills = mkdtempSync(join(tmpdir(), 'phada-skill-source-'))
  })

  afterEach(() => {
    rmSync(temp, { recursive: true, force: true })
    rmSync(skills, { recursive: true, force: true })
  })

  it('wraps a skill folder in a phada-skills plugin with a symlink', async () => {
    mkdirSync(join(skills, 'own'))
    writeFileSync(join(skills, 'own', 'SKILL.md'), 'Own.')

    const plugin = await writeSkillPlugin(temp, {
      kind: 'file',
      fileKind: 'skill',
      path: join(skills, 'own', 'SKILL.md'),
      dir: join(skills, 'own'),
      name: 'my-review',
    })

    expect(plugin.invoke).toBe('phada-skills:my-review')
    expect(plugin.pluginDir).toBe(join(temp, 'phada-skills'))
    expect(
      JSON.parse(readFileSync(join(temp, 'phada-skills', '.claude-plugin', 'plugin.json'), 'utf8')),
    ).toEqual({
      name: 'phada-skills',
    })
    expect(lstatSync(join(temp, 'phada-skills', 'skills', 'my-review')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(temp, 'phada-skills', 'skills', 'my-review'))).toBe(
      join(skills, 'own'),
    )
    expect(plugin.addDirs).toEqual([realpathSync(join(skills, 'own'))])
  })

  it('wraps a command file in the commands folder', async () => {
    writeFileSync(join(skills, 'check.md'), 'Check.')

    const plugin = await writeSkillPlugin(temp, {
      kind: 'file',
      fileKind: 'command',
      path: join(skills, 'check.md'),
      dir: skills,
      name: 'check',
    })

    expect(plugin.invoke).toBe('phada-skills:check')
    expect(readlinkSync(join(temp, 'phada-skills', 'commands', 'check.md'))).toBe(
      join(skills, 'check.md'),
    )
    expect(plugin.addDirs).toEqual([realpathSync(skills)])
  })

  it('loads a plugin from its own folder', async () => {
    const plugin = await writeSkillPlugin(temp, {
      kind: 'plugin',
      pluginDir: skills,
      invoke: 'pp:r',
    })

    expect(plugin).toEqual({ pluginDir: skills, invoke: 'pp:r', addDirs: [realpathSync(skills)] })
  })

  it('needs no plugin for a skill built into Claude Code', async () => {
    expect(await writeSkillPlugin(temp, { kind: 'builtin', invoke: 'security-review' })).toEqual({
      invoke: 'security-review',
      addDirs: [],
    })
  })
})
