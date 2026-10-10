import { describe, expect, it } from 'vitest'
import { REVIEW_REPORT_JSON_SCHEMA } from './report-schema.js'

interface ObjectSchema {
  type: string
  properties: Record<string, { items?: ObjectSchema; type?: unknown }>
  required: string[]
  additionalProperties: boolean
}

const report = REVIEW_REPORT_JSON_SCHEMA as unknown as ObjectSchema

describe('REVIEW_REPORT_JSON_SCHEMA', () => {
  it('describes the report as a strict object with every field required', () => {
    expect(report.type).toBe('object')
    expect(report.required).toEqual(['summary', 'files', 'findings'])
    expect(report.additionalProperties).toBe(false)
  })

  it('requires every finding field and allows null only for the fix and the rule', () => {
    const finding = report.properties.findings?.items

    expect(finding?.required).toEqual([
      'severity',
      'confidence',
      'file',
      'line',
      'title',
      'why',
      'fix',
      'rule',
      'sources',
    ])
    expect(finding?.additionalProperties).toBe(false)
    expect(finding?.properties.fix?.type).toEqual(['string', 'null'])
    expect(finding?.properties.rule?.type).toEqual(['string', 'null'])
    expect(finding?.properties.sources?.type).toBe('array')
    expect(finding?.properties.why?.type).toBe('string')
  })

  it('requires every file field', () => {
    const file = report.properties.files?.items

    expect(file?.required).toEqual(['path', 'change'])
    expect(file?.additionalProperties).toBe(false)
  })

  it('declares no JSON Schema dialect, which the Claude CLI rejects', () => {
    expect(REVIEW_REPORT_JSON_SCHEMA).not.toHaveProperty('$schema')
  })
})
