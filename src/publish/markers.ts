export const FINDING_MARKER = '<!-- phada:finding -->'

const REVIEW_MARKER = /<!-- phada:review sha=([0-9a-f]{40}) findings=(\d+) -->\s*$/
const TRAILING_FINDING_MARKER = /<!-- phada:finding -->\s*$/

export interface ReviewMarker {
  sha: string
  findings: number
}

export function reviewMarker({ sha, findings }: ReviewMarker): string {
  return `<!-- phada:review sha=${sha} findings=${findings} -->`
}

export function parseReviewMarker(body: string): ReviewMarker | undefined {
  const match = REVIEW_MARKER.exec(body)
  if (match === null) return undefined
  const [, sha = '', findings = ''] = match
  return { sha, findings: Number(findings) }
}

export function hasFindingMarker(body: string): boolean {
  return TRAILING_FINDING_MARKER.test(body)
}
