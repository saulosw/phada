import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MCP_SERVER_NAME } from '../investigation/mcp/mcp-server.js'
import type { CommandPolicy, NativeSkillRef } from './types.js'

export const SKILL_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'Bash', 'Task', 'Skill']

export const READ_ONLY_COMMANDS: readonly string[] = [
  'git diff',
  'git log',
  'git show',
  'git blame',
  'git status',
  'git rev-parse',
  'git merge-base',
  'git ls-files',
  'git grep',
  'gh',
]

const ALWAYS_ALLOWED: readonly string[] = ['Read', 'Grep', 'Glob', 'Task', 'Skill']
const WRAPPER_PLUGIN = 'phada-skills'

export function allowedSkillTools(
  policy: CommandPolicy,
  toolNames: readonly string[],
  userMcpAllowed: readonly string[],
): string[] {
  const shell =
    policy === 'all'
      ? ['Bash']
      : [...READ_ONLY_COMMANDS, ...(policy === 'read-only' ? [] : policy)].map(
          (command) => `Bash(${command}:*)`,
        )
  return [
    ...ALWAYS_ALLOWED,
    ...shell,
    ...toolNames.map((name) => `mcp__${MCP_SERVER_NAME}__${name}`),
    ...userMcpAllowed,
  ]
}

export interface SkillPlugin {
  pluginDir?: string
  invoke: string
  addDirs: string[]
}

export async function writeSkillPlugin(tempDir: string, ref: NativeSkillRef): Promise<SkillPlugin> {
  switch (ref.kind) {
    case 'builtin':
      return { invoke: ref.invoke, addDirs: [] }
    case 'plugin':
      return {
        pluginDir: ref.pluginDir,
        invoke: ref.invoke,
        addDirs: [await realpath(ref.pluginDir)],
      }
    case 'file': {
      const pluginDir = join(tempDir, WRAPPER_PLUGIN)
      const name = ref.name.replace(/[^\w.-]/g, '-')
      await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
      await writeFile(
        join(pluginDir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: WRAPPER_PLUGIN }),
      )
      if (ref.fileKind === 'skill') {
        await mkdir(join(pluginDir, 'skills'))
        await symlink(ref.dir, join(pluginDir, 'skills', name))
      } else {
        await mkdir(join(pluginDir, 'commands'))
        await symlink(ref.path, join(pluginDir, 'commands', `${name}.md`))
      }
      return { pluginDir, invoke: `${WRAPPER_PLUGIN}:${name}`, addDirs: [await realpath(ref.dir)] }
    }
  }
}
