import { InvalidReviewReportError } from './errors.js'
import { ReportEnvelopeSchema, ReportFileSchema, ReportFindingSchema } from './report-schema.js'
import type { Finding } from './types.js'

const PREVIEW_LENGTH = 500

export interface ReportFile {
  path: string
  change: string
}

export interface ParsedReport {
  summary: string
  files: ReportFile[]
  findings: Finding[]
  invalid: number
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
  const findings = envelope.data.findings.flatMap((item) => {
    const parsed = ReportFindingSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
  const files = envelope.data.files.flatMap((item) => {
    const parsed = ReportFileSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
  return {
    summary: envelope.data.summary,
    files,
    findings,
    invalid: envelope.data.findings.length - findings.length,
  }
}

function jsonObjects(text: string): unknown[] {
  const objects: unknown[] = []
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = matchingBrace(text, start)
    if (end === undefined) continue
    try {
      objects.push(JSON.parse(text.slice(start, end + 1)) as unknown)
      start = end
    } catch {
      continue
    }
  }
  return objects
}

function matchingBrace(text: string, start: number): number | undefined {
  let depth = 0
  let inString = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (char === '\\') index++
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) return index
    }
  }
  return undefined
}

function preview(text: string): string {
  return text.trim().slice(0, PREVIEW_LENGTH)
}
