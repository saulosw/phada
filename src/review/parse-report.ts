import type { z } from 'zod'
import { InvalidReviewReportError } from './errors.js'
import { jsonObjects, preview } from './json-objects.js'
import {
  ReportClaimSchema,
  ReportEnvelopeSchema,
  ReportFileSchema,
  ReportFindingSchema,
  SuggestionSchema,
} from './report-schema.js'
import type { Claim, Finding } from './types.js'

export type ReportFile = z.infer<typeof ReportFileSchema>

export interface ParsedReport {
  summary: string
  files: ReportFile[]
  findings: Finding[]
  invalid: number
  claims: Claim[] | undefined
  invalidClaims: number
}

export function parseReviewReport(text: string): ParsedReport {
  const objects = jsonObjects(text)
  if (objects.length === 0) {
    throw new InvalidReviewReportError('no JSON object in the answer', preview(text))
  }
  const envelope = objects
    .map((object) => ReportEnvelopeSchema.safeParse(object))
    .find((parsed) => parsed.success)
  if (envelope === undefined || !envelope.success) {
    throw new InvalidReviewReportError('missing summary, files or findings', preview(text))
  }
  const findings = envelope.data.findings.flatMap((item): Finding[] => {
    const parsed = ReportFindingSchema.safeParse(item)
    if (!parsed.success) return []
    const { rule, sources, suggestion, scope, ...finding } = parsed.data
    const fix = SuggestionSchema.safeParse(suggestion)
    const ruleKey = typeof rule === 'string' ? rule.trim() : ''
    const texts = (Array.isArray(sources) ? sources : [])
      .filter((source): source is string => typeof source === 'string')
      .map((source) => source.trim())
      .filter((source) => source !== '')
    return [
      {
        ...finding,
        ...(ruleKey === '' ? {} : { rule: ruleKey }),
        ...(texts.length === 0 ? {} : { sources: texts }),
        ...(fix.success ? { suggestion: fix.data } : {}),
        ...(scope === 'repository' ? { scope } : {}),
      },
    ]
  })
  const files = envelope.data.files.flatMap((item) => {
    const parsed = ReportFileSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
  const listed = envelope.data.claims
  const claims = Array.isArray(listed)
    ? listed.flatMap((item): Claim[] => {
        const parsed = ReportClaimSchema.safeParse(item)
        return parsed.success ? [parsed.data] : []
      })
    : undefined
  return {
    summary: envelope.data.summary,
    files,
    findings,
    invalid: envelope.data.findings.length - findings.length,
    claims,
    invalidClaims: Array.isArray(listed) ? listed.length - (claims?.length ?? 0) : 0,
  }
}
