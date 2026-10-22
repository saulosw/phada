import { dirname, join } from 'node:path'
import { skillPolicy } from '../app/native-skill.js'
import type { ReviewSettings } from '../config/merge-config.js'
import { userConfigDir } from '../config/user-config.js'
import type { PullRequest } from '../github/pull-request.js'
import { READ_ONLY_COMMANDS } from '../providers/claude-skill-args.js'
import type { BlockedCommand, CommandPolicy } from '../providers/types.js'
import { TRUSTED_ASSOCIATIONS } from '../watch/filters.js'

export interface FixContext {
  external: boolean
  configPath: string
  policy?: CommandPolicy
}

const FILE_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob'])
const NEVER_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
])
const PLUMBING: ReadonlySet<string> = new Set([
  'cd',
  'pushd',
  'popd',
  'echo',
  'true',
  'tee',
  'cat',
  'head',
  'tail',
  'grep',
  'wc',
  'sort',
  'xargs',
])
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/
const MAX_PREFIX_WORDS = 2

export function blockedFix({ tool, input }: BlockedCommand, context: FixContext): string {
  if (NEVER_TOOLS.has(tool)) return 'Phada never lets a skill write files or use the web'
  if (tool !== 'Bash' && !FILE_TOOLS.has(tool))
    return 'this tool is not available to a native skill'
  if (context.external) {
    return 'this pull request is from an outside author: the skill always runs read-only'
  }
  if (FILE_TOOLS.has(tool)) {
    const folder = /\.[\w-]+$/.test(input) ? dirname(input) : input
    return `allow it with review.readDirs: ["${folder}"] in ${context.configPath}`
  }
  const prefixes = commandPrefixes(input, context.policy ?? 'read-only').map(
    (prefix) => `"${prefix}"`,
  )
  return `allow it with review.commands: [${prefixes.join(', ')}] in ${context.configPath}`
}

export function blockedFixer(input: {
  pullRequest: Pick<PullRequest, 'private' | 'association'>
  env: NodeJS.ProcessEnv
  home: string
  review?: ReviewSettings
}): (blocked: BlockedCommand) => string {
  const context: FixContext = {
    external:
      !input.pullRequest.private && !TRUSTED_ASSOCIATIONS.has(input.pullRequest.association),
    configPath: join(userConfigDir(input.env, input.home), 'config.yml'),
    policy: skillPolicy(input.pullRequest, input.review ?? {}).commands,
  }
  return (blocked) => blockedFix(blocked, context)
}

function commandPrefixes(command: string, policy: CommandPolicy): string[] {
  const segments = command
    .split(/&&|\|\||;|\|/)
    .map((segment) => words(segment))
    .filter((segment) => segment.length > 0)
  const denied = segments.filter((segment) => !allowed(segment, policy))
  const work = denied.filter((segment) => !PLUMBING.has(segment[0] ?? ''))
  const chosen =
    work.length > 0 ? work.slice(0, 1) : denied.length > 0 ? denied : segments.slice(0, 1)
  return [...new Set(chosen.map(prefixOf))]
}

function prefixOf(segment: readonly string[]): string {
  if (PLUMBING.has(segment[0] ?? '')) return segment[0] ?? ''
  const prefix: string[] = []
  for (const [index, word] of segment.entries()) {
    if (index > 0 && (word.startsWith('-') || word.includes('/'))) break
    prefix.push(word)
    if (prefix.length === MAX_PREFIX_WORDS) break
  }
  return prefix.join(' ')
}

function words(segment: string): string[] {
  const all = segment.trim().split(/\s+/).filter(Boolean)
  const start = all.findIndex((word) => !ENV_ASSIGNMENT.test(word))
  return start === -1 ? [] : all.slice(start)
}

function allowed(segment: readonly string[], policy: CommandPolicy): boolean {
  if (policy === 'all') return true
  const text = segment.join(' ')
  const commands = [...READ_ONLY_COMMANDS, ...(policy === 'read-only' ? [] : policy)]
  return commands.some((command) => text === command || text.startsWith(`${command} `))
}
