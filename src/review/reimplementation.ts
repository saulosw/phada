import { MAX_SOURCES } from './context-findings.js'
import type { DiffFile } from './diff-lines.js'
import type { Finding, Severity } from './types.js'

export interface ReadEvidence {
  repo: string
  reads: Iterable<string>
  diffFiles: readonly DiffFile[]
}

export interface BackedFindings {
  findings: Finding[]
  unbacked: Finding[]
}

interface ExistingCode {
  repo?: string
  path: string
  line: number
}

const EXISTING = /^(?:([\w.-]+\/[\w.-]+):)?([^:\s][^:]*):(\d+)(?:-\d+)?$/
const LINE_SUFFIX = /:\d+(?:-\d+)?$/
const STANDS_ON_ITS_OWN: ReadonlySet<Severity> = new Set(['P0', 'P1'])

export function withBackedReimplementations(
  findings: readonly Finding[],
  { repo, reads, diffFiles }: ReadEvidence,
): BackedFindings {
  const read = new Set([...reads].map(readKey))
  const kept: Finding[] = []
  const unbacked: Finding[] = []
  for (const finding of findings) {
    if (finding.existing === undefined) {
      kept.push(finding)
      continue
    }
    const code = existingCode(finding.existing, repo)
    if (code === undefined || !isBacked(code, read, diffFiles)) {
      if (STANDS_ON_ITS_OWN.has(finding.severity)) kept.push(withoutExisting(finding))
      else unbacked.push(finding)
      continue
    }
    kept.push(withExistingSource(finding, finding.existing))
  }
  return { findings: kept, unbacked }
}

function existingCode(existing: string, reviewed: string): ExistingCode | undefined {
  const match = EXISTING.exec(existing.trim())
  if (match === null) return undefined
  const [, repo, path = '', line = ''] = match
  const code = { path: repoPath(path), line: Number(line) }
  return repo === undefined || repo === reviewed ? code : { ...code, repo }
}

function isBacked(
  { repo, path, line }: ExistingCode,
  read: ReadonlySet<string>,
  diffFiles: readonly DiffFile[],
): boolean {
  if (repo !== undefined) return read.has(`${repo}:${path}`)
  if (!read.has(path)) return false
  return diffFiles.find((file) => file.path === path)?.added.has(line) !== true
}

function withoutExisting({ existing: _existing, ...finding }: Finding): Finding {
  return finding
}

function withExistingSource(finding: Finding, existing: string): Finding {
  const sources = finding.sources ?? []
  const path = existing.replace(LINE_SUFFIX, '')
  if (sources.some((source) => source.replace(LINE_SUFFIX, '') === path)) return finding
  return { ...finding, sources: [existing, ...sources].slice(0, MAX_SOURCES) }
}

function readKey(read: string): string {
  const separator = read.indexOf(':')
  return separator === -1
    ? repoPath(read)
    : `${read.slice(0, separator)}:${repoPath(read.slice(separator + 1))}`
}

function repoPath(path: string): string {
  return path.trim().replace(/^(?:\.\/|\/)+/, '')
}
