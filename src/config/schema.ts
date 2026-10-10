import { z } from 'zod'

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
    })
    .optional(),
})

export type ConfigFile = z.infer<typeof ConfigFileSchema>
export type ConfigRule = z.infer<typeof RuleSchema>
