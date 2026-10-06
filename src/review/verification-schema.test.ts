import { describe, expect, it } from 'vitest'
import { VERIFICATION_JSON_SCHEMA } from './verification-schema.js'

interface ObjectSchema {
  type: string
  properties: Record<string, { items?: ObjectSchema; enum?: unknown }>
  required: string[]
  additionalProperties: boolean
}

const verification = VERIFICATION_JSON_SCHEMA as unknown as ObjectSchema

describe('VERIFICATION_JSON_SCHEMA', () => {
  it('describes the verification as a strict object with a list of verdicts', () => {
    expect(verification.type).toBe('object')
    expect(verification.required).toEqual(['verdicts'])
    expect(verification.additionalProperties).toBe(false)
  })

  it('requires every verdict field and allows only confirmed or rejected', () => {
    const verdict = verification.properties.verdicts?.items

    expect(verdict?.required).toEqual(['id', 'verdict', 'severity', 'confidence', 'reason'])
    expect(verdict?.additionalProperties).toBe(false)
    expect(verdict?.properties.verdict?.enum).toEqual(['confirmed', 'rejected'])
    expect(verdict?.properties.severity?.enum).toEqual(['P0', 'P1', 'P2'])
  })

  it('declares no JSON Schema dialect, which the Claude CLI rejects', () => {
    expect(VERIFICATION_JSON_SCHEMA).not.toHaveProperty('$schema')
  })
})
