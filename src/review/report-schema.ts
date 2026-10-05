import { z } from 'zod'
import type { JsonSchema } from '../providers/types.js'

export const SEVERITIES = ['P0', 'P1', 'P2'] as const

export const ReportFindingSchema = z
  .object({
    severity: z.enum(SEVERITIES),
    confidence: z.number().int().min(0).max(100),
    file: z.string().min(1),
    line: z.number().int().positive(),
    title: z.string().min(1),
    why: z.string().min(1),
    fix: z.string().nullable(),
  })
  .strict()

export const ReportFileSchema = z.object({ path: z.string().min(1), change: z.string() }).strict()

export const ReviewReportSchema = z
  .object({
    summary: z.string(),
    files: z.array(ReportFileSchema),
    findings: z.array(ReportFindingSchema),
  })
  .strict()

export const ReportEnvelopeSchema = z.object({
  summary: z.string(),
  files: z.array(z.unknown()),
  findings: z.array(z.unknown()),
})

export const REVIEW_REPORT_JSON_SCHEMA: JsonSchema = withoutDialect(
  z.toJSONSchema(ReviewReportSchema),
)

function withoutDialect(schema: Record<string, unknown>): JsonSchema {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$schema'))
}
