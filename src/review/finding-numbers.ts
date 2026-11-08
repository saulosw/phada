import type { Finding, Severity } from './types.js'

export interface NumberedFinding {
  number: number
  finding: Finding
}

export const SEVERITIES: readonly Severity[] = ['P0', 'P1', 'P2']

export function isSeverity(value: string | null): value is Severity {
  return SEVERITIES.some((severity) => severity === value)
}

export function numberFindings(findings: readonly Finding[]): NumberedFinding[] {
  return SEVERITIES.flatMap((severity) =>
    findings.filter((finding) => finding.severity === severity),
  ).map((finding, index) => ({ number: index + 1, finding }))
}
