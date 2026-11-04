import type { ComparedFile } from '../github/compare-commits.js'
import type { PullRequestReviewState } from '../github/pull-request-reviews.js'
import { cutBytes } from '../context/byte-cut.js'
import { findingFingerprint, threadFeedback } from './feedback.js'
import { isNearMiss, MISS_BODY_BYTES, missWindow, siteKey } from './misses.js'
import type { ElementSite, LineSpan, Miss } from './misses.js'
import { phadaThreads } from './phada-state.js'
import { writtenLine } from './written-line.js'

export type CommitComparisons = ReadonlyMap<string, readonly ComparedFile[] | 'unavailable'>

export interface RunFinding {
  file: string
  line: number
  title: string
  body: string
}

export interface FindingRun {
  id: number
  headSha: string
  source: 'watch' | 'manual' | 'replay'
  finishedAt: string
  findings: readonly RunFinding[]
}

export interface CommitPair {
  base: string
  head: string
}

export interface VanishedInput {
  repo: string
  number: number
  runs: readonly FindingRun[]
  state: PullRequestReviewState
  known: ReadonlySet<string>
  comparisons?: CommitComparisons
  elementsAt?: (commitSha: string, file: string) => readonly LineSpan[] | undefined
}

interface Candidate {
  found: FindingRun
  lost: FindingRun
  finding: RunFinding
  fingerprint: string
}

interface Hunk {
  oldStart: number
  oldCount: number
  newCount: number
}

const PHADA_KEY = /^phada:\d+:/
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/

export function comparisonKey(base: string, head: string): string {
  return `${base}...${head}`
}

export function vanishedElementSites(input: VanishedInput): ElementSite[] {
  const sites = new Map<string, ElementSite>()
  for (const { found, finding } of candidates(input)) {
    sites.set(siteKey(found.headSha, finding.file), {
      commitSha: found.headSha,
      file: finding.file,
    })
  }
  return [...sites.values()]
}

export function vanishedComparisons(input: VanishedInput): CommitPair[] {
  const pairs = new Map<string, CommitPair>()
  for (const candidate of candidates(input)) {
    if (publishedNear(input, candidate)) continue
    const { found, lost } = candidate
    pairs.set(comparisonKey(found.headSha, lost.headSha), {
      base: found.headSha,
      head: lost.headSha,
    })
  }
  return [...pairs.values()]
}

export function decideVanished(input: VanishedInput): Miss[] {
  const decided = new Map<string, Miss>()
  for (const candidate of candidates(input)) {
    if (decided.has(candidate.fingerprint) || publishedNear(input, candidate)) continue
    const miss = vanishedMiss(input, candidate)
    if (miss !== undefined) decided.set(candidate.fingerprint, miss)
  }
  return [...decided.values()]
}

function candidates(input: VanishedInput): Candidate[] {
  const published = new Set(threadFeedback(input.state).map(({ fingerprint }) => fingerprint))
  const known = new Set([...input.known].flatMap(knownFingerprint))
  const runs = input.runs.filter((run) => !Number.isNaN(Date.parse(run.finishedAt))).sort(byFinish)
  const real = runs.filter((run) => run.source !== 'replay')
  return runs.flatMap((found) => {
    const lost = lostBy(found, real)
    if (lost === undefined) return []
    return found.findings.flatMap((finding) => {
      const fingerprint = findingFingerprint(finding.file, finding.title)
      return published.has(fingerprint) || known.has(fingerprint)
        ? []
        : [{ found, lost, finding, fingerprint }]
    })
  })
}

function lostBy(found: FindingRun, real: readonly FindingRun[]): FindingRun | undefined {
  const lost = real.filter((run) => run.headSha !== found.headSha).at(-1)
  if (lost === undefined) return undefined
  if (found.source !== 'replay' && byFinish(lost, found) <= 0) return undefined
  return lost
}

function byFinish(a: FindingRun, b: FindingRun): number {
  return Date.parse(a.finishedAt) - Date.parse(b.finishedAt) || a.id - b.id
}

function knownFingerprint(key: string): string[] {
  return PHADA_KEY.test(key) ? [key.replace(PHADA_KEY, '')] : []
}

function publishedNear(input: VanishedInput, { found, finding }: Candidate): boolean {
  const elements = input.elementsAt?.(found.headSha, finding.file)
  return phadaThreads(input.state).some((thread) => {
    const line = writtenLine(thread)
    return line !== null && isNearMiss(finding, { file: thread.path, line }, elements)
  })
}

function vanishedMiss(input: VanishedInput, { found, lost, finding }: Candidate): Miss | undefined {
  const files = input.comparisons?.get(comparisonKey(found.headSha, lost.headSha))
  if (files === undefined || files === 'unavailable') return undefined
  const window = missWindow(finding, input.elementsAt?.(found.headSha, finding.file) ?? [])
  const offset = unchangedOffset(files, finding.file, window)
  if (offset === undefined) return undefined
  const kept = lost.findings.some(
    ({ file, line }) =>
      file === finding.file && line >= window.startLine + offset && line <= window.endLine + offset,
  )
  if (kept) return undefined
  const text = finding.body === '' ? finding.title : `${finding.title}\n\n${finding.body}`
  return {
    key: `phada:${found.id}:${findingFingerprint(finding.file, finding.title)}`,
    origin: 'phada',
    seen: 'missed-live',
    repo: input.repo,
    number: input.number,
    reviewedSha: lost.headSha,
    commitSha: lost.headSha,
    file: finding.file,
    line: finding.line + offset,
    author: 'phada',
    body: cutBytes(text, MISS_BODY_BYTES, { truncated: 0 }),
    createdAt: lost.finishedAt,
  }
}

function unchangedOffset(
  files: readonly ComparedFile[],
  path: string,
  window: LineSpan,
): number | undefined {
  const compared = files.find((file) => file.path === path || file.previousPath === path)
  if (compared === undefined) return 0
  if (
    compared.path !== path ||
    compared.status === 'renamed' ||
    compared.status === 'removed' ||
    compared.patch === undefined
  ) {
    return undefined
  }
  let offset = 0
  for (const hunk of hunksOf(compared.patch)) {
    if (below(hunk, window)) continue
    if (!above(hunk, window)) return undefined
    offset += hunk.newCount - hunk.oldCount
  }
  return offset
}

function hunksOf(patch: string): Hunk[] {
  return patch.split('\n').flatMap((line) => {
    const match = HUNK_HEADER.exec(line)
    if (match === null) return []
    return [
      {
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newCount: match[3] === undefined ? 1 : Number(match[3]),
      },
    ]
  })
}

function above(hunk: Hunk, window: LineSpan): boolean {
  const lastOld = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart + hunk.oldCount - 1
  return lastOld < window.startLine
}

function below(hunk: Hunk, window: LineSpan): boolean {
  return hunk.oldCount === 0 ? hunk.oldStart >= window.endLine : hunk.oldStart > window.endLine
}
