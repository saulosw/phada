import { z } from 'zod'
import type { JsonSchema } from '../providers/types.js'

export const SeveritySchema = z.enum(['P0', 'P1', 'P2'])

export const ConfidenceSchema = z.number().int().min(0).max(100)

const FINDING_SHAPE = {
  severity: SeveritySchema,
  confidence: ConfidenceSchema,
  file: z.string().min(1),
  line: z.number().int().positive(),
  title: z.string().min(1),
  why: z.string().min(1),
  fix: z.string().nullable(),
}

const REFERENCE_SHAPE = {
  rule: z.string().nullable(),
  sources: z.array(z.string()),
}

const FILE_SHAPE = { path: z.string().min(1), change: z.string() }

export const ReportFindingSchema = z.object({
  ...FINDING_SHAPE,
  rule: z.unknown().optional(),
  sources: z.unknown().optional(),
})

export const ReportFileSchema = z.object(FILE_SHAPE)

export const ReportEnvelopeSchema = z.object({
  summary: z.string(),
  files: z.array(z.unknown()),
  findings: z.array(z.unknown()),
})

export const REVIEW_REPORT_JSON_SCHEMA = providerSchema(
  z.strictObject({
    summary: z.string(),
    files: z.array(z.strictObject(FILE_SHAPE)),
    findings: z.array(z.strictObject({ ...FINDING_SHAPE, ...REFERENCE_SHAPE })),
  }),
)

export function providerSchema(schema: z.ZodType): JsonSchema {
  return Object.fromEntries(
    Object.entries(z.toJSONSchema(schema)).filter(([key]) => key !== '$schema'),
  )
}
