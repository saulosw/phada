import { findDiffFile } from './diff-lines.js'
import type { DiffFile } from './diff-lines.js'
import type { ReportFile } from './parse-report.js'
import type { FileChange, Finding, Severity } from './types.js'

export const CONFIDENCE_FLOOR = 50
export const MAX_CONFIDENCE = 100
export const VERIFY_CANDIDATE_FLOOR = 25
const MAX_WORTH_CHECKING = 5

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { P0: 0, P1: 1, P2: 2 }

export interface Candidates {
  candidates: Finding[]
  belowFloor: number
  outsideDiff: number
  duplicate: number
}

export interface CutSplit {
  findings: Finding[]
  worthChecking: Finding[]
  worthCheckingOmitted: number
  belowFloor: number
}

export function isConfidenceCut(value: number): boolean {
  return Number.isInteger(value) && value >= CONFIDENCE_FLOOR && value <= MAX_CONFIDENCE
}

export function prepareCandidates(
  findings: readonly Finding[],
  diffFiles: readonly DiffFile[],
  minConfidence: number,
  floor = CONFIDENCE_FLOOR,
): Candidates {
  const aboveFloor = findings.filter((finding) => finding.confidence >= floor)
  const inDiff = aboveFloor.flatMap((finding) => {
    const file = findDiffFile(finding.file, diffFiles)
    return file?.lines.has(finding.line) ? [{ ...finding, file: file.path }] : []
  })
  const candidates = withoutDuplicates(inDiff, minConfidence)
  return {
    candidates,
    belowFloor: findings.length - aboveFloor.length,
    outsideDiff: aboveFloor.length - inDiff.length,
    duplicate: inDiff.length - candidates.length,
  }
}

export function splitAtCut(findings: readonly Finding[], minConfidence: number): CutSplit {
  const aboveFloor = findings.filter(isAboveFloor)
  const unsure = aboveFloor.filter((finding) => !clearsCut(finding, minConfidence)).sort(byPriority)
  return {
    findings: aboveFloor.filter((finding) => clearsCut(finding, minConfidence)).sort(byPriority),
    worthChecking: unsure.slice(0, MAX_WORTH_CHECKING),
    worthCheckingOmitted: Math.max(unsure.length - MAX_WORTH_CHECKING, 0),
    belowFloor: findings.length - aboveFloor.length,
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

function withoutDuplicates(findings: readonly Finding[], minConfidence: number): Finding[] {
  const kept = new Map<string, Finding>()
  for (const finding of findings) {
    const key = duplicateKey(finding)
    const current = kept.get(key)
    if (current === undefined || byPreference(finding, current, minConfidence) < 0) {
      kept.set(key, finding)
    }
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

function byPreference(a: Finding, b: Finding, minConfidence: number): number {
  return Number(clearsCut(b, minConfidence)) - Number(clearsCut(a, minConfidence)) || byWeight(a, b)
}

function isAboveFloor(finding: Finding): boolean {
  return finding.confidence >= CONFIDENCE_FLOOR
}

function clearsCut(finding: Finding, minConfidence: number): boolean {
  return finding.confidence >= minConfidence
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
