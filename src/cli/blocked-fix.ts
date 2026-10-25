import { dirname } from 'node:path'
import { skillPolicy } from '../app/native-skill.js'
import type { ReviewSettings } from '../config/merge-config.js'
import { userConfigFile } from '../config/user-config.js'
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
const CREDENTIAL_PLACES: readonly RegExp[] = [
  /(^|\/)\.(ssh|aws|gnupg|docker|kube|azure)(\/|$)/,
  /(^|\/)\.config\/(gh|gcloud|hub)(\/|$)/,
  /(^|\/)\.(netrc|npmrc|pypirc|git-credentials)$/,
  /^\/etc(\/|$)/,
]
const MAX_PREFIX_WORDS = 2

export function blockedFix({ tool, input }: BlockedCommand, context: FixContext): string {
  if (NEVER_TOOLS.has(tool)) return 'Phada never lets a skill write files or use the web'
  if (tool !== 'Bash' && !FILE_TOOLS.has(tool))
    return 'this tool is not available to a native skill'
  if (context.external) {
    return 'this pull request is from an outside author: the skill always runs read-only'
  }
  if (FILE_TOOLS.has(tool)) {
    if (CREDENTIAL_PLACES.some((place) => place.test(input))) {
      return `the skill tried to read ${input}, which holds credentials; Phada never suggests allowing it`
    }
    const folder = tool === 'Read' ? dirname(input) : input
    return `allow it with review.readDirs: ["${folder}"] in ${context.configPath}`
  }
  const prefixes = commandPrefixes(input, context.policy ?? 'read-only').map(
    (prefix) => `"${prefix}"`,
  )
  if (prefixes.length === 0) {
    return 'Claude Code refused it, probably because it reaches outside the checkout'
  }
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
    configPath: userConfigFile(input.env, input.home),
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
  return [...new Set(denied.map(prefixOf))]
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
