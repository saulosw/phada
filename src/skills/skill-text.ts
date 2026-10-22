import { join } from 'node:path'
import type { LocalFileSystem } from '../config/local-files.js'
import { SkillError } from './errors.js'
import type { InstalledSkill } from './installed-skills.js'

export const SKILL_TEXT_LIMIT_BYTES = 32_768

export interface SkillText {
  text: string
  bytes: number
  included: string[]
  omitted: string[]
}

const FENCE = /^---\s*$/
const CITED_FILE = /[^\s`'"()<>[\]{}*,;]+\.md\b/g
const SKILL_FILE = 'SKILL.md'

export async function readSkillText(
  files: LocalFileSystem,
  skill: InstalledSkill,
): Promise<SkillText> {
  const raw = await files.readText(skill.path)
  const body = bodyOf(raw ?? '')
  const label = `Skill "${skill.qualified}" (${skill.path})`
  if (body === '') throw new SkillError(`${label} is empty.`)
  let bytes = byteLength(body)
  if (bytes > SKILL_TEXT_LIMIT_BYTES) throw new SkillError(`${label} is larger than 32 KB.`)
  const parts = [body]
  const included: string[] = []
  const omitted: string[] = []
  for (const name of skill.kind === 'skill' ? await citedFiles(files, skill.dir, body) : []) {
    const content = (await files.readText(join(skill.dir, name)))?.trim()
    if (content === undefined || content === '') continue
    const part = `=== ${name} ===\n${content}`
    const added = byteLength(`\n\n${part}`)
    if (bytes + added > SKILL_TEXT_LIMIT_BYTES) {
      omitted.push(name)
      continue
    }
    parts.push(part)
    included.push(name)
    bytes += added
  }
  return { text: parts.join('\n\n'), bytes, included, omitted }
}

function bodyOf(text: string): string {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (!FENCE.test(lines[0] ?? '')) return lines.join('\n').trim()
  const end = lines.findIndex((line, index) => index > 0 && FENCE.test(line))
  return (end === -1 ? lines : lines.slice(end + 1)).join('\n').trim()
}

async function citedFiles(files: LocalFileSystem, dir: string, body: string): Promise<string[]> {
  const present = new Set((await files.listDir(dir)) ?? [])
  const cited = (body.match(CITED_FILE) ?? []).filter(
    (name) => !name.includes('/') && !name.includes(':') && name !== SKILL_FILE,
  )
  return [...new Set(cited)].filter((name) => present.has(name))
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}
