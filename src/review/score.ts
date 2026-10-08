import type { Finding, Score, ScoreValue, Severity } from './types.js'

const MAX_LOCATIONS = 3

export interface ScoreFocus {
  severity: Severity
  count: number
  locations: string[]
}

export function scoreFindings(findings: readonly Finding[]): Score {
  const p0 = countOf(findings, 'P0')
  const p1 = countOf(findings, 'P1')
  const value = scoreValue(p0, p1, findings.length)
  const focus = scoreFocus(findings)
  if (focus === undefined) return { value, reason: 'no problems found' }
  const noun = focus.count === 1 ? 'finding' : 'findings'
  return {
    value,
    reason: `${focus.count} ${focus.severity} ${noun} (${focus.locations.join(', ')})`,
  }
}

export function scoreFocus(findings: readonly Finding[]): ScoreFocus | undefined {
  const severity = (['P0', 'P1', 'P2'] as const).find((level) => countOf(findings, level) > 0)
  if (severity === undefined) return undefined
  const focused = findings.filter((finding) => finding.severity === severity)
  const locations = focused
    .slice(0, MAX_LOCATIONS)
    .map((finding) => `${baseName(finding.file)}:${finding.line}`)
  if (focused.length > MAX_LOCATIONS) locations.push('…')
  return { severity, count: focused.length, locations }
}

function scoreValue(p0: number, p1: number, total: number): ScoreValue {
  if (p0 >= 2) return 0
  if (p0 === 1) return 1
  if (p1 >= 2) return 2
  if (p1 === 1) return 3
  if (total > 0) return 4
  return 5
}

function countOf(findings: readonly Finding[], severity: Severity): number {
  return findings.filter((finding) => finding.severity === severity).length
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
