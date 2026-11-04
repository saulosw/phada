import { findingFixture } from './finding.js'

export interface ReportOverrides {
  claims?: unknown
  summary?: string
  files?: unknown[]
  findings?: unknown[]
}

export function reviewReportJson(overrides: ReportOverrides = {}): string {
  return JSON.stringify({
    claims: [],
    summary: 'Adds a spend endpoint.',
    files: [
      { path: 'src/shop.ts', checked: 'diff', against: null, change: 'Adds the spend endpoint' },
    ],
    findings: [findingFixture()],
    ...overrides,
  })
}
