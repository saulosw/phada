import { findDiffFile } from './diff-lines.js'
import type { DiffFile } from './diff-lines.js'
import type { ReportFile } from './parse-report.js'
import type { FileChange, Finding, Severity } from './types.js'

const CONFIDENCE_FLOOR = 50
export const MIN_CONFIDENCE = 80

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { P0: 0, P1: 1, P2: 2 }

export interface Selection {
  findings: Finding[]
  belowFloor: number
  outsideDiff: number
  duplicate: number
  belowCut: number
}

export function selectFindings(
  findings: readonly Finding[],
  diffFiles: readonly DiffFile[],
): Selection {
  const aboveFloor = findings.filter((finding) => finding.confidence >= CONFIDENCE_FLOOR)
  const inDiff = aboveFloor.flatMap((finding) => {
    const file = findDiffFile(finding.file, diffFiles)
    return file?.lines.has(finding.line) ? [{ ...finding, file: file.path }] : []
  })
  const unique = withoutDuplicates(inDiff)
  const shown = unique.filter(clearsCut)
  return {
    findings: shown.sort(byPriority),
    belowFloor: findings.length - aboveFloor.length,
    outsideDiff: aboveFloor.length - inDiff.length,
    duplicate: inDiff.length - unique.length,
    belowCut: unique.length - shown.length,
  }
}

export function summarizeFiles(
  reportFiles: readonly ReportFile[],
  findings: readonly Finding[],
  diffFiles: readonly DiffFile[],
): FileChange[] {
  const changes = new Map<string, string>()
  for (const { path, change } of reportFiles) {
    const file = findDiffFile(path, diffFiles)
    if (file !== undefined && !changes.has(file.path)) changes.set(file.path, change)
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

function withoutDuplicates(findings: readonly Finding[]): Finding[] {
  const kept = new Map<string, Finding>()
  for (const finding of findings) {
    const key = duplicateKey(finding)
    const current = kept.get(key)
    if (current === undefined || byPreference(finding, current) < 0) kept.set(key, finding)
  }
  return [...kept.values()]
}

function duplicateKey({ file, line, title }: Finding): string {
  return JSON.stringify([file, line, normalizedTitle(title)])
}

function normalizedTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function byPreference(a: Finding, b: Finding): number {
  return Number(clearsCut(b)) - Number(clearsCut(a)) || byWeight(a, b)
}

function clearsCut(finding: Finding): boolean {
  return finding.confidence >= MIN_CONFIDENCE
}

function byPriority(a: Finding, b: Finding): number {
  return byWeight(a, b) || compareText(a.file, b.file) || a.line - b.line
}

function byWeight(a: Finding, b: Finding): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.confidence - a.confidence
}

function compareText(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
