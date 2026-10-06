import type { Verdict } from '../../src/review/verification-schema.js'

export function verdictFixture(overrides: Partial<Verdict> = {}): Verdict {
  return {
    id: 1,
    verdict: 'confirmed',
    severity: 'P1',
    confidence: 90,
    reason: 'The diff shows it.',
    ...overrides,
  }
}

export function verificationJson(verdicts: unknown[]): string {
  return JSON.stringify({ verdicts })
}
