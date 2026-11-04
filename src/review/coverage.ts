import { findDiffFile } from './diff-lines.js'
import type { DiffFile } from './diff-lines.js'
import type {
  Coverage,
  CoverageGap,
  CoverageGapKind,
  CoverageLevel,
  FileDeclaration,
} from './types.js'

export const LOW_COVERAGE_BELOW_PERCENT = 70
export const NEW_FILE_COMPARED_FROM_LINES = 50

export interface CoverageInput {
  files: readonly DiffFile[]
  declarations: readonly FileDeclaration[]
  reads: ReadonlySet<string>
  verified: boolean
}

interface Judgment {
  covered: boolean
  declaredOnly: boolean
  gap?: CoverageGap
}

interface Evidence {
  verified: boolean
  read(path: string): boolean
  inDiff(path: string): boolean
  movedFrom(path: string): boolean
}

const REASONS: readonly { kind: CoverageGapKind; text: (count: number) => string }[] = [
  { kind: 'missing', text: (count) => `${filesText(count)} not accounted for` },
  {
    kind: 'not-compared',
    text: (count) =>
      `${count} new ${count === 1 ? 'file' : 'files'} not compared with existing code`,
  },
  { kind: 'skipped', text: (count) => `${filesText(count)} skipped` },
]

export function measureCoverage({ files, declarations, reads, verified }: CoverageInput): Coverage {
  const reviewable = files.filter(({ status }) => status !== 'binary')
  const declaredBy = new Map<string, FileDeclaration[]>()
  for (const declaration of declarations) {
    const file = findDiffFile(declaration.path, reviewable)
    if (file !== undefined)
      declaredBy.set(file.path, [...(declaredBy.get(file.path) ?? []), declaration])
  }
  const readPaths = new Set([...reads].map(repoPath))
  const diffPaths = new Set(files.map(({ path }) => path))
  const sourcePaths = new Set(
    files
      .filter(({ status, removedAt }) => status === 'deleted' || removedAt.size > 0)
      .map(({ path }) => path),
  )
  const evidence: Evidence = {
    verified,
    read: (path) => readPaths.has(repoPath(path)),
    inDiff: (path) => diffPaths.has(repoPath(path)),
    movedFrom: (path) => sourcePaths.has(repoPath(path)),
  }
  const judgments = reviewable.map((file) =>
    bestOf(file, declaredBy.get(file.path) ?? [], evidence),
  )
  const gaps = judgments.flatMap(({ gap }) => (gap === undefined ? [] : [gap]))
  const covered = judgments.filter((judgment) => judgment.covered).length
  const declaredOnly = judgments.filter((judgment) => judgment.declaredOnly).length
  return {
    level: levelOf(covered, reviewable.length),
    covered,
    total: reviewable.length,
    declaredOnly,
    skipped: gaps.filter(({ kind }) => kind === 'skipped').length,
    gaps,
    verified,
    reason: reasonOf(gaps, declaredOnly),
  }
}

export function gapText({ kind, reason }: CoverageGap): string {
  switch (kind) {
    case 'missing':
      return 'not accounted for'
    case 'skipped':
      return reason === undefined ? 'skipped' : `skipped (${reason.replace(/\s+/g, ' ').trim()})`
    case 'not-compared':
      return 'new file not compared with existing code'
    case 'declared-only':
      return 'declared as read but never read'
  }
}

function bestOf(
  file: DiffFile,
  declarations: readonly FileDeclaration[],
  evidence: Evidence,
): Judgment {
  const judgments = declarations.map((declaration) => judge(file, declaration, evidence))
  return (
    judgments.sort((a, b) => rank(a) - rank(b))[0] ?? {
      covered: false,
      declaredOnly: false,
      gap: { path: file.path, kind: 'missing' },
    }
  )
}

function judge(file: DiffFile, declaration: FileDeclaration, evidence: Evidence): Judgment {
  const { path } = file
  if (declaration.checked === 'skipped') {
    const reason = declaration.change.trim()
    return {
      covered: false,
      declaredOnly: false,
      gap: { path, kind: 'skipped', ...(reason === '' ? {} : { reason }) },
    }
  }
  if (!evidence.verified) return { covered: true, declaredOnly: false }
  const { checked, against } = declaration
  if (
    needsComparison(file) &&
    checked === 'compared' &&
    against !== null &&
    evidence.movedFrom(against)
  ) {
    return { covered: true, declaredOnly: false }
  }
  const unread =
    (checked === 'file' && !evidence.read(path)) ||
    (checked === 'compared' && (against === null || !evidence.read(against)))
  if (needsComparison(file)) {
    const compared =
      checked === 'compared' && !unread && against !== null && !evidence.inDiff(against)
    return compared
      ? { covered: true, declaredOnly: false }
      : { covered: false, declaredOnly: unread, gap: { path, kind: 'not-compared' } }
  }
  return unread
    ? { covered: true, declaredOnly: true, gap: { path, kind: 'declared-only' } }
    : { covered: true, declaredOnly: false }
}

function needsComparison(file: DiffFile): boolean {
  return file.status === 'added' && file.added.size >= NEW_FILE_COMPARED_FROM_LINES
}

function rank({ covered, declaredOnly, gap }: Judgment): number {
  const base = covered ? 0 : gap?.kind === 'not-compared' ? 2 : 4
  return base + (declaredOnly ? 1 : 0)
}

function levelOf(covered: number, total: number): CoverageLevel {
  if (covered === total) return 'full'
  return covered * 100 < total * LOW_COVERAGE_BELOW_PERCENT ? 'low' : 'partial'
}

function reasonOf(gaps: readonly CoverageGap[], declaredOnly: number): string {
  const parts = REASONS.flatMap(({ kind, text }) => {
    const count = gaps.filter((gap) => gap.kind === kind).length
    return count === 0 ? [] : [text(count)]
  })
  if (declaredOnly > 0) parts.push(`${filesText(declaredOnly)} declared as read but never read`)
  return parts.length === 0 ? 'every file accounted for' : parts.join(', ')
}

function filesText(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`
}

function repoPath(path: string): string {
  return path.trim().replace(/^(?:\.\/|\/)+/, '')
}
