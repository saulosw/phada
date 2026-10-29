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
    expect(report.required).toEqual(['claims', 'summary', 'files', 'findings'])
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
      'suggestion',
      'scope',
    ])
    expect(finding?.additionalProperties).toBe(false)
    expect(finding?.properties.fix?.type).toEqual(['string', 'null'])
    expect(finding?.properties.rule?.type).toEqual(['string', 'null'])
    expect(finding?.properties.sources?.type).toBe('array')
    expect(finding?.properties.why?.type).toBe('string')
  })

  it('limits the scope of a finding to the change or the repository', () => {
    const scope = report.properties.findings?.items?.properties.scope as unknown as {
      enum: string[]
    }

    expect(scope.enum).toEqual(['change', 'repository'])
  })

  it('describes the suggestion as a strict object or null', () => {
    const suggestion = report.properties.findings?.items?.properties.suggestion as unknown as {
      anyOf: [ObjectSchema, { type: string }]
    }

    expect(suggestion.anyOf[1]).toEqual({ type: 'null' })
    expect(suggestion.anyOf[0].required).toEqual([
      'startLine',
      'endLine',
      'original',
      'replacement',
    ])
    expect(suggestion.anyOf[0].additionalProperties).toBe(false)
  })

  it('requires every file field', () => {
    const file = report.properties.files?.items

    expect(file?.required).toEqual(['path', 'change'])
    expect(file?.additionalProperties).toBe(false)
  })

  it('requires every claim field and limits the verdict to confirmed, contradicted or unverified', () => {
    const claim = report.properties.claims?.items as unknown as ObjectSchema & {
      properties: Record<string, { enum?: string[]; type?: unknown }>
    }

    expect(report.properties.claims?.type).toBe('array')
    expect(claim.required).toEqual(['claim', 'verdict', 'evidence'])
    expect(claim.additionalProperties).toBe(false)
    expect(claim.properties.verdict?.enum).toEqual(['confirmed', 'contradicted', 'unverified'])
    expect(claim.properties.evidence?.type).toBe('string')
  })

  it('declares no JSON Schema dialect, which the Claude CLI rejects', () => {
    expect(REVIEW_REPORT_JSON_SCHEMA).not.toHaveProperty('$schema')
  })
})
