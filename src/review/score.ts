import type { Finding, Score, ScoreValue, Severity } from './types.js'

const MAX_LOCATIONS = 3

export function scoreFindings(findings: readonly Finding[]): Score {
  const p0 = countOf(findings, 'P0')
  const p1 = countOf(findings, 'P1')
  const value = scoreValue(p0, p1, findings.length)
  if (findings.length === 0) return { value, reason: 'no problems found' }
  const severity: Severity = p0 > 0 ? 'P0' : p1 > 0 ? 'P1' : 'P2'
  return {
    value,
    reason: reasonFor(
      findings.filter((finding) => finding.severity === severity),
      severity,
    ),
  }
}

function scoreValue(p0: number, p1: number, total: number): ScoreValue {
  if (p0 >= 2) return 0
  if (p0 === 1) return 1
  if (p1 >= 2) return 2
  if (p1 === 1) return 3
  if (total > 0) return 4
  return 5
}

function reasonFor(findings: readonly Finding[], severity: Severity): string {
  const locations = findings
    .slice(0, MAX_LOCATIONS)
    .map((finding) => `${baseName(finding.file)}:${finding.line}`)
  if (findings.length > MAX_LOCATIONS) locations.push('…')
  const noun = findings.length === 1 ? 'finding' : 'findings'
  return `${findings.length} ${severity} ${noun} (${locations.join(', ')})`
}

function countOf(findings: readonly Finding[], severity: Severity): number {
  return findings.filter((finding) => finding.severity === severity).length
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
