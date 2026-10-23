import { join, posix } from 'node:path'
import type { LocalFileSystem } from '../config/local-files.js'
import { readFrontmatter } from '../context/frontmatter.js'
import type { SkillRoots } from './skill-locations.js'

export interface InstalledSkill {
  name: string
  qualified: string
  kind: 'skill' | 'command'
  root: 'claude' | 'claude-plugin' | 'codex' | 'agents'
  path: string
  dir: string
  pluginDir?: string
  pluginName?: string
}

export interface SkillListing {
  skills: InstalledSkill[]
  searched: string[]
  warnings: string[]
}

const SKILL_FILE = 'SKILL.md'

export async function listInstalledSkills(
  files: LocalFileSystem,
  roots: SkillRoots,
): Promise<SkillListing> {
  const claudeSkills = join(roots.claude, 'skills')
  const claudeCommands = join(roots.claude, 'commands')
  const pluginsFile = join(roots.claude, 'plugins', 'installed_plugins.json')
  const codexSkills = join(roots.codex, 'skills')
  const agentSkills = join(roots.agents, 'skills')
  const warnings: string[] = []
  const skills = [
    ...(await skillsIn(files, claudeSkills, 'claude')),
    ...(await commandsIn(files, claudeCommands, 'claude')),
    ...(await skillsIn(files, codexSkills, 'codex')),
    ...(await skillsIn(files, agentSkills, 'agents')),
    ...(await pluginSkills(files, pluginsFile, warnings)),
  ]
  return {
    skills,
    searched: [claudeSkills, claudeCommands, pluginsFile, codexSkills, agentSkills],
    warnings,
  }
}

async function skillsIn(
  files: LocalFileSystem,
  folder: string,
  root: InstalledSkill['root'],
  plugin?: string,
): Promise<InstalledSkill[]> {
  const found: InstalledSkill[] = []
  for (const entry of (await files.listDir(folder)) ?? []) {
    if (entry.startsWith('.')) continue
    const skill = await skillAt(files, join(folder, entry), root, plugin)
    if (skill !== undefined) found.push(skill)
  }
  return found.sort((a, b) => compareText(a.qualified, b.qualified))
}

async function skillAt(
  files: LocalFileSystem,
  dir: string,
  root: InstalledSkill['root'],
  plugin?: string,
): Promise<InstalledSkill | undefined> {
  const path = join(dir, SKILL_FILE)
  const text = await files.readText(path)
  if (text === null) return undefined
  const name = frontmatterName(text) ?? posix.basename(dir)
  return { name, qualified: qualify(plugin, name), kind: 'skill', root, path, dir }
}

async function commandsIn(
  files: LocalFileSystem,
  folder: string,
  root: InstalledSkill['root'],
  plugin?: string,
): Promise<InstalledSkill[]> {
  const entries = (await files.listDir(folder)) ?? []
  return entries
    .filter((entry) => entry.endsWith('.md') && !entry.startsWith('.'))
    .map((entry) => {
      const name = entry.slice(0, -'.md'.length)
      return {
        name,
        qualified: qualify(plugin, name),
        kind: 'command' as const,
        root,
        path: join(folder, entry),
        dir: folder,
      }
    })
}

async function pluginSkills(
  files: LocalFileSystem,
  pluginsFile: string,
  warnings: string[],
): Promise<InstalledSkill[]> {
  const text = await files.readText(pluginsFile)
  if (text === null) return []
  const plugins = installPaths(text)
  if (plugins === undefined) {
    warnings.push(`Could not read ${pluginsFile}: plugin skills were not searched.`)
    return []
  }
  const found: InstalledSkill[] = []
  for (const [plugin, installPath] of plugins) {
    const manifest = await readManifest(files, installPath)
    const own = { pluginDir: installPath, pluginName: manifest.name ?? plugin }
    for (const skill of [
      ...(await pluginSkillFolders(files, plugin, installPath, manifest)),
      ...(await pluginCommands(files, plugin, installPath, manifest)),
    ]) {
      found.push({ ...skill, ...own })
    }
  }
  return found.sort((a, b) => compareText(a.qualified, b.qualified))
}

async function pluginSkillFolders(
  files: LocalFileSystem,
  plugin: string,
  installPath: string,
  manifest: PluginManifest,
): Promise<InstalledSkill[]> {
  const defaultFolder = join(installPath, 'skills')
  const listed = insidePlugin(installPath, manifest.skills) ?? []
  const hasDefault = (await files.listDir(defaultFolder)) !== null
  if (manifest.skills === undefined && !hasDefault) {
    const text = await files.readText(join(installPath, SKILL_FILE))
    if (text === null) return []
    const name = frontmatterName(text) ?? plugin
    return [
      {
        name,
        qualified: qualify(plugin, name),
        kind: 'skill',
        root: 'claude-plugin',
        path: join(installPath, SKILL_FILE),
        dir: installPath,
      },
    ]
  }
  const found = new Map<string, InstalledSkill>()
  for (const folder of [defaultFolder, ...listed]) {
    const single = await skillAt(files, folder, 'claude-plugin', plugin)
    const skills =
      single === undefined ? await skillsIn(files, folder, 'claude-plugin', plugin) : [single]
    for (const skill of skills) found.set(skill.path, skill)
  }
  return [...found.values()]
}

async function pluginCommands(
  files: LocalFileSystem,
  plugin: string,
  installPath: string,
  manifest: PluginManifest,
): Promise<InstalledSkill[]> {
  const paths = insidePlugin(installPath, manifest.commands) ?? [join(installPath, 'commands')]
  const found: InstalledSkill[] = []
  for (const path of paths) {
    if (path.endsWith('.md')) {
      if ((await files.readText(path)) === null) continue
      const name = manifest.commandNames?.get(path) ?? posix.basename(path).slice(0, -'.md'.length)
      found.push({
        name,
        qualified: qualify(plugin, name),
        kind: 'command',
        root: 'claude-plugin',
        path,
        dir: posix.dirname(path),
      })
      continue
    }
    found.push(...(await commandsIn(files, path, 'claude-plugin', plugin)))
  }
  return found
}

function installPaths(text: string): [string, string][] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !isRecord(parsed.plugins)) return undefined
  const paths: [string, string][] = []
  for (const [key, entries] of Object.entries(parsed.plugins)) {
    const first: unknown = Array.isArray(entries) ? entries[0] : undefined
    const installPath = isRecord(first) ? first.installPath : undefined
    const plugin = key.split('@')[0]
    if (typeof installPath === 'string' && plugin) paths.push([plugin, installPath])
  }
  return paths
}

interface PluginManifest {
  name?: string
  skills?: string[]
  commands?: string[]
  commandNames?: Map<string, string>
}

async function readManifest(files: LocalFileSystem, installPath: string): Promise<PluginManifest> {
  const text = await files.readText(join(installPath, '.claude-plugin', 'plugin.json'))
  if (text === null) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed)) return {}
    const skills = pathList(parsed.skills)
    const commandMap = isRecord(parsed.commands) ? commandSources(parsed.commands) : undefined
    const commands = commandMap === undefined ? pathList(parsed.commands) : [...commandMap.keys()]
    const commandNames =
      commandMap === undefined
        ? undefined
        : new Map([...commandMap].map(([source, name]) => [posix.join(installPath, source), name]))
    const name =
      typeof parsed.name === 'string' && parsed.name.trim() !== '' ? parsed.name.trim() : undefined
    return {
      ...(name === undefined ? {} : { name }),
      ...(skills === undefined ? {} : { skills }),
      ...(commands === undefined ? {} : { commands }),
      ...(commandNames === undefined ? {} : { commandNames }),
    }
  } catch {
    return {}
  }
}

function commandSources(map: Record<string, unknown>): Map<string, string> {
  const sources = new Map<string, string>()
  for (const [name, entry] of Object.entries(map)) {
    if (isRecord(entry) && typeof entry.source === 'string') sources.set(entry.source, name)
  }
  return sources
}

function pathList(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return undefined
}

function insidePlugin(installPath: string, paths: string[] | undefined): string[] | undefined {
  if (paths === undefined) return undefined
  const root = posix.normalize(installPath).replace(/\/+$/, '')
  return paths.flatMap((path) => {
    const joined = posix.normalize(posix.join(root, path)).replace(/\/+$/, '')
    return joined === root || joined.startsWith(`${root}/`) ? [joined] : []
  })
}

function frontmatterName(text: string): string | undefined {
  const frontmatter = readFrontmatter(text)
  if (frontmatter.status !== 'ok') return undefined
  const name = frontmatter.fields.get('name')?.[0]?.trim()
  return name ? name : undefined
}

function qualify(plugin: string | undefined, name: string): string {
  return plugin === undefined ? name : `${plugin}:${name}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareText(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
