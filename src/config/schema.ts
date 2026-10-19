import { z } from 'zod'
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

const WatchedRepoSchema = z.union([
  RepoName,
  z.strictObject({
    repo: RepoName,
    publish: z.boolean().optional(),
    allowExternal: z.boolean().optional(),
    authors: z.array(z.string().trim().min(1)).optional(),
    labels: z.array(z.string().trim().min(1)).optional(),
    baseBranches: z.array(z.string().trim().min(1)).optional(),
  }),
])

const WatchSchema = z.strictObject({
  interval: Duration.refine(
    (text) => !DURATION.test(text) || durationMs(text) >= MIN_WATCH_INTERVAL_MS,
    'must be at least 60s',
  ).optional(),
  settle: Duration.optional(),
  maxReviewsPerHour: z.number().int().min(1).max(60).optional(),
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

const ContextFileSchema = z.strictObject({
  path: Pattern,
  description: z.string().optional(),
})

export const ConfigFileSchema = z.strictObject({
  provider: z.enum(['claude', 'codex', 'ollama']).optional(),
  model: z.string().trim().min(1).optional(),
  localFiles: z.array(z.string().trim().min(1)).optional(),
  language: z.string().regex(LANGUAGE_TAG, 'use a tag like en or pt-BR').optional(),
  minConfidence: z.number().int().min(50).max(100).optional(),
  verify: z.boolean().optional(),
  investigate: z.boolean().optional(),
  resolveThreads: z.boolean().optional(),
  mcp: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[\w .-]+$/, 'use the server name as your AI CLI shows it'),
    )
    .optional(),
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
  watch: WatchSchema.optional(),
})

export type ConfigFile = z.infer<typeof ConfigFileSchema>
export type ConfigRule = z.infer<typeof RuleSchema>
export type WatchConfig = z.infer<typeof WatchSchema>
