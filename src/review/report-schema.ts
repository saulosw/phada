import { z } from 'zod'
import type { JsonSchema } from '../providers/types.js'

const FINDING_SHAPE = {
  severity: z.enum(['P0', 'P1', 'P2']),
  confidence: z.number().int().min(0).max(100),
  file: z.string().min(1),
  line: z.number().int().positive(),
  title: z.string().min(1),
  why: z.string().min(1),
  fix: z.string().nullable(),
}

const FILE_SHAPE = { path: z.string().min(1), change: z.string() }

export const ReportFindingSchema = z.object(FINDING_SHAPE)

export const ReportFileSchema = z.object(FILE_SHAPE)

export const ReportEnvelopeSchema = z.object({
  summary: z.string(),
  files: z.array(z.unknown()),
  findings: z.array(z.unknown()),
})

export const REVIEW_REPORT_JSON_SCHEMA: JsonSchema = withoutDialect(
  z.toJSONSchema(
    z.strictObject({
      summary: z.string(),
      files: z.array(z.strictObject(FILE_SHAPE)),
      findings: z.array(z.strictObject(FINDING_SHAPE)),
    }),
  ),
)

function withoutDialect(schema: Record<string, unknown>): JsonSchema {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$schema'))
}
