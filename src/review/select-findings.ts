import type { ReportFile } from './parse-report.js'
import type { FileChange, Finding, Severity } from './types.js'

export const CONFIDENCE_FLOOR = 50
export const MIN_CONFIDENCE = 80

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { P0: 0, P1: 1, P2: 2 }

export interface Selection {
  findings: Finding[]
  belowFloor: number
  belowCut: number
}

export function selectFindings(findings: readonly Finding[]): Selection {
  const shown = findings.filter((finding) => finding.confidence >= MIN_CONFIDENCE)
  const belowFloor = findings.filter((finding) => finding.confidence < CONFIDENCE_FLOOR).length
  return {
    findings: [...shown].sort(byPriority),
    belowFloor,
    belowCut: findings.length - shown.length - belowFloor,
  }
}

export function summarizeFiles(
  reportFiles: readonly ReportFile[],
  findings: readonly Finding[],
): FileChange[] {
  const changes = new Map<string, string>()
  for (const { path, change } of reportFiles) {
    if (!changes.has(path)) changes.set(path, change)
  }
  for (const { file } of findings) {
    if (!changes.has(file)) changes.set(file, '')
  }
  return [...changes]
    .map(([path, change]) => ({
      path,
      change,
      findings: findings.filter((finding) => finding.file === path).length,
    }))
    .sort((a, b) => b.findings - a.findings || compareText(a.path, b.path))
}

function byPriority(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    b.confidence - a.confidence ||
    compareText(a.file, b.file) ||
    a.line - b.line
  )
}

function compareText(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
