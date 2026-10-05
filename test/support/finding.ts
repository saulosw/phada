import type { Finding } from '../../src/review/types.js'

export function findingFixture(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'P1',
    confidence: 90,
    file: 'src/shop.ts',
    line: 1,
    title: 'spend has no auth',
    why: 'Anyone can spend crystals for any user.',
    fix: 'Use the authenticated user id.',
    ...overrides,
  }
}
