import { z } from 'zod'
import { looksLikeSecret } from '../providers/redact-secrets.js'
import { DURATION, durationMs } from './duration.js'

export const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

const Pattern = z
  .string()
  .trim()
  .min(1)
  .refine(
    (pattern) => !pattern.startsWith('!'),
    'exceptions with ! are not supported; list only the files to match',
  )

const Globs = z.array(Pattern)

const RuleSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[A-Za-z0-9][\w.-]*$/, 'use letters, digits, dots, dashes or underscores')
    .optional(),
  rule: z.string().trim().min(1),
  scope: Globs.optional(),
  severity: z.enum(['P0', 'P1', 'P2']).optional(),
})

const RepoName = z
  .string()
  .trim()
  .regex(/^[\w.-]+\/[\w.-]+$/, 'use owner/repo')

const RelatedRepoSchema = z.union([
  RepoName,
  z.strictObject({
    repo: RepoName,
    description: z.string().trim().max(300).optional(),
  }),
])

export const MIN_WATCH_INTERVAL_MS = 60_000

const Duration = z.string().trim().regex(DURATION, 'use a duration like 90s, 5m or 1h')

const WhenSchema = z.strictObject({ command: z.string().trim().min(1, 'give the command to run') })

const WatchedRepoSchema = z.union([
  RepoName,
  z.strictObject({
    repo: RepoName,
    publish: z.boolean().optional(),
    allowExternal: z.boolean().optional(),
    authors: z.array(z.string().trim().min(1)).optional(),
    labels: z.array(z.string().trim().min(1)).optional(),
    baseBranches: z.array(z.string().trim().min(1)).optional(),
    when: WhenSchema.optional(),
  }),
])

const WatchSchema = z.strictObject({
  interval: Duration.refine(
    (text) => !DURATION.test(text) || durationMs(text) >= MIN_WATCH_INTERVAL_MS,
    'must be at least 60s',
  ).optional(),
  settle: Duration.optional(),
  maxReviewsPerHour: z.number().int().min(1).max(60).optional(),
  when: WhenSchema.optional(),
  repos: z
    .array(WatchedRepoSchema)
    .min(1, 'list at least one owner/repo')
    .superRefine((repos, context) => {
      const seen = new Set<string>()
      for (const entry of repos) {
        const name = (typeof entry === 'string' ? entry : entry.repo).toLowerCase()
        if (seen.has(name)) context.addIssue({ code: 'custom', message: `${name} is listed twice` })
        seen.add(name)
      }
    }),
})

export const REVIEW_EVENTS = [
  'review.started',
  'review.finished',
  'review.failed',
  'review.skipped',
] as const
export type ReviewEventName = (typeof REVIEW_EVENTS)[number]

const MAX_HOOK_TIMEOUT_MS = 600_000
const HookCommand = z.string().trim().min(1, 'give the command to run')

const HooksSchema = z.strictObject({
  'review.started': HookCommand.optional(),
  'review.finished': HookCommand.optional(),
  'review.failed': HookCommand.optional(),
  'review.skipped': HookCommand.optional(),
  timeout: Duration.refine(
    (text) => !DURATION.test(text) || durationMs(text) <= MAX_HOOK_TIMEOUT_MS,
    'must be 10m at most',
  ).optional(),
})

export const SKILL_NAME = /^[\w.-]+(:[\w.-]+)?$/

const SkillName = z
  .string()
  .trim()
  .regex(SKILL_NAME, 'use the skill name, or plugin:skill for a skill of a plugin')

const MIN_REVIEW_TIMEOUT_MS = 60_000
const MAX_REVIEW_TIMEOUT_MS = 7_200_000

const Command = z
  .string()
  .trim()
  .min(1)
  .regex(/^[^\n*,]+$/, 'write the command without line breaks, commas or *')

const ReviewSchema = z.strictObject({
  prompt: z
    .strictObject({
      file: z.string().trim().min(1),
      mode: z.enum(['append', 'replace']).optional(),
    })
    .optional(),
  skills: z
    .array(
      z.union([
        SkillName,
        z.strictObject({
          name: SkillName,
          paths: Globs.optional(),
          mode: z.enum(['native', 'text']).optional(),
        }),
      ]),
    )
    .optional(),
  commands: z
    .union([z.literal('read-only'), z.literal('all'), z.array(Command)], {
      error: 'use read-only, all or a list of commands',
    })
    .optional(),
  readDirs: z.array(z.string().trim().min(1)).optional(),
  timeout: Duration.refine(
    (text) =>
      !DURATION.test(text) ||
      (durationMs(text) >= MIN_REVIEW_TIMEOUT_MS && durationMs(text) <= MAX_REVIEW_TIMEOUT_MS),
    'use a duration from 1m to 2h',
  ).optional(),
})

const ContextFileSchema = z.strictObject({
  path: Pattern,
  description: z.string().optional(),
})

const MCP_NAME = /^[\w .-]+$/
const DECLARED_MCP_NAME = /^[A-Za-z0-9_-]{1,32}$/
const VARIABLE_REFERENCE = /\$\{([^}]*)\}/g
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
export const SECRET_KEY = /authorization|token|key|secret|password|credential/i
export const PHADA_MCP_NAME = 'phada'

const McpName = z.string().trim().regex(MCP_NAME, 'use the server name as your AI CLI shows it')

const McpObjectSchema = z
  .strictObject({
    name: McpName,
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().trim().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    tools: z.array(z.string().trim().min(1)).min(1).optional(),
    description: z.string().trim().min(1).max(300).optional(),
  })
  .superRefine(checkMcpObject)

const McpEntrySchema = z.union([McpName, McpObjectSchema])

export type McpObject = z.infer<typeof McpObjectSchema>
export type McpEntry = z.infer<typeof McpEntrySchema>

function checkMcpObject(entry: McpObject, context: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) =>
    context.addIssue({ code: 'custom', path, message })
  if (entry.command !== undefined && entry.url !== undefined) {
    issue([], 'use either command or url')
  }
  const declared = entry.command !== undefined || entry.url !== undefined
  if (declared && entry.name === PHADA_MCP_NAME) {
    issue(['name'], "phada is the name of Phada's own server; choose another name")
  } else if (declared && !DECLARED_MCP_NAME.test(entry.name)) {
    issue(['name'], 'use letters, digits, dashes or underscores (up to 32)')
  }
  if ((entry.args !== undefined || entry.env !== undefined) && entry.command === undefined) {
    issue([entry.env === undefined ? 'args' : 'env'], 'env goes with command (args too)')
  }
  if (entry.headers !== undefined && entry.url === undefined) {
    issue(['headers'], 'headers go with url')
  }
  const values: CheckedValue[] = [
    ...(entry.command === undefined ? [] : [{ path: ['command'], value: entry.command }]),
    ...(entry.args ?? []).map((value, index) => ({ path: ['args', index], value })),
    ...Object.entries(entry.env ?? {}).map(([key, value]) => ({
      path: ['env', key],
      value,
      key,
      variable: key,
    })),
    ...Object.entries(entry.headers ?? {}).map(([key, value]) => ({
      path: ['headers', key],
      value,
      key,
      variable: `${entry.name}_${key}`,
    })),
    ...(entry.url === undefined ? [] : [{ path: ['url'], value: entry.url }]),
  ]
  for (const { path, value, key, variable } of values) {
    const references = [...value.matchAll(VARIABLE_REFERENCE)].map((match) => match[1] ?? '')
    const invalid = references.find((name) => !VARIABLE_NAME.test(name))
    if (invalid !== undefined) {
      issue(path, `\${${invalid}} is not a variable name; use letters, digits and underscores`)
      continue
    }
    const literal = value.replace(VARIABLE_REFERENCE, '')
    const keyed = key !== undefined && SECRET_KEY.test(key)
    if (looksLikeSecret(literal) || (keyed && references.length === 0)) {
      const suggestion = (variable ?? 'TOKEN').toUpperCase().replace(/[^A-Z0-9_]/g, '_')
      issue(path, `put the secret in an environment variable, e.g. '\${${suggestion}}'`)
    }
  }
}

interface CheckedValue {
  path: (string | number)[]
  value: string
  key?: string
  variable?: string
}

function noRepeatedServer(entries: readonly McpEntry[], context: z.RefinementCtx): void {
  const seen = new Set<string>()
  entries.forEach((entry, index) => {
    const name = typeof entry === 'string' ? entry : entry.name
    if (seen.has(name)) {
      context.addIssue({ code: 'custom', path: [index], message: `${name} is listed twice` })
    }
    seen.add(name)
  })
}

export const ConfigFileSchema = z.strictObject({
  provider: z.enum(['claude', 'codex', 'ollama']).optional(),
  model: z.string().trim().min(1).optional(),
  localFiles: z.array(z.string().trim().min(1)).optional(),
  language: z.string().regex(LANGUAGE_TAG, 'use a tag like en or pt-BR').optional(),
  minConfidence: z.number().int().min(50).max(100).optional(),
  verify: z.boolean().optional(),
  investigate: z.boolean().optional(),
  resolveThreads: z.boolean().optional(),
  mcp: z.array(McpEntrySchema).superRefine(noRepeatedServer).optional(),
  ignore: Globs.optional(),
  rules: z.array(RuleSchema).optional(),
  disabledRules: z.array(z.string().trim().min(1)).optional(),
  context: z
    .strictObject({
      defaults: z.boolean().optional(),
      files: z.array(ContextFileSchema).optional(),
      repos: z.array(RelatedRepoSchema).optional(),
      privateOnPublic: z.boolean().optional(),
    })
    .optional(),
  history: z.boolean().optional(),
  review: ReviewSchema.optional(),
  watch: WatchSchema.optional(),
  hooks: HooksSchema.optional(),
})

export type ConfigFile = z.infer<typeof ConfigFileSchema>
export type ConfigRule = z.infer<typeof RuleSchema>
export type ReviewConfig = z.infer<typeof ReviewSchema>
export type WatchConfig = z.infer<typeof WatchSchema>
