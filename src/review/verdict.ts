import type { Finding } from './types.js'

export type ReviewVerdict = 'clean' | 'comments' | 'blocking'
export type Verdict = ReviewVerdict | 'failed' | 'skipped'

export function reviewVerdict(result: {
  findings: readonly Finding[]
  worthChecking: readonly Finding[]
}): ReviewVerdict {
  if (result.findings.some(({ severity }) => severity === 'P0' || severity === 'P1'))
    return 'blocking'
  return result.findings.length > 0 || result.worthChecking.length > 0 ? 'comments' : 'clean'
}
