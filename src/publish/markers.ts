import type { Severity } from '../review/types.js'

export const FINDING_MARKER = '<!-- phada:finding -->'

const REVIEW_MARKER =
  /<!-- phada:review sha=([0-9a-f]{40}) findings=(\d+)(?: diff=([0-9a-f]{16}))? -->\s*$/
const THREAD_TITLE = /^\*\*(P[0-2])\*\* · (.+) · [^·]+ \d+$/
const TRAILING_FINDING_MARKER = /<!-- phada:finding(?: skill=[^\s<>]+)? -->\s*$/
const TRAILING_RESOLVED_MARKER = /<!-- phada:resolved sha=[0-9a-f]{40} -->\s*$/

export interface ReviewMarker {
  sha: string
  findings: number
  diff?: string
}

export function reviewMarker({ sha, findings, diff }: ReviewMarker): string {
  const fingerprint = diff === undefined ? '' : ` diff=${diff}`
  return `<!-- phada:review sha=${sha} findings=${findings}${fingerprint} -->`
}

export function parseReviewMarker(body: string): ReviewMarker | undefined {
  const match = REVIEW_MARKER.exec(body)
  if (match === null) return undefined
  const [, sha = '', findings = '', diff] = match
  return { sha, findings: Number(findings), ...(diff === undefined ? {} : { diff }) }
}

export function findingMarker(skill: string | undefined): string {
  if (skill === undefined) return FINDING_MARKER
  return `<!-- phada:finding skill=${encodeURIComponent(skill).replace(/%3A/g, ':')} -->`
}

export function hasFindingMarker(body: string): boolean {
  return TRAILING_FINDING_MARKER.test(body)
}

export function resolvedMarker(sha: string): string {
  return `<!-- phada:resolved sha=${sha} -->`
}

export function hasResolvedMarker(body: string): boolean {
  return TRAILING_RESOLVED_MARKER.test(body)
}

export function findingTitle(body: string): string | undefined {
  return titleLine(body)?.[2]
}

export function findingSeverity(body: string): Severity | undefined {
  return titleLine(body)?.[1] as Severity | undefined
}

function titleLine(body: string): RegExpExecArray | null {
  const firstLine = body.split('\n', 1)[0]?.trim() ?? ''
  return THREAD_TITLE.exec(firstLine)
}
