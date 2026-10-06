import type { ReviewProvider } from '../providers/types.js'
import { parseVerification } from './parse-verification.js'
import type { Finding, RejectedFinding, ReviewRequest, Verification } from './types.js'
import type { Verdict } from './verification-schema.js'
import { buildVerifyPrompt } from './verify-prompt.js'

export interface AppliedVerdicts {
  findings: Finding[]
  rejected: RejectedFinding[]
  confirmed: number
  unverified: number
}

export interface CheckedCandidates {
  findings: Finding[]
  verification: Verification
}

export async function verifyCandidates(
  request: ReviewRequest,
  candidates: readonly Finding[],
  verifier: ReviewProvider,
  nonce: string,
): Promise<CheckedCandidates> {
  if (candidates.length === 0) {
    return {
      findings: [],
      verification: { candidates: 0, confirmed: 0, unverified: 0, rejected: [], durationMs: 0 },
    }
  }
  const { text, durationMs, usage } = await verifier.review(
    buildVerifyPrompt(request, candidates, nonce),
  )
  const { findings, rejected, confirmed, unverified } = applyVerdicts(
    candidates,
    parseVerification(text),
  )
  return {
    findings,
    verification: {
      candidates: candidates.length,
      confirmed,
      unverified,
      rejected,
      durationMs,
      ...(usage === undefined ? {} : { usage }),
    },
  }
}

export function applyVerdicts(
  candidates: readonly Finding[],
  verdicts: readonly Verdict[],
): AppliedVerdicts {
  const byId = new Map<number, Verdict>()
  for (const verdict of verdicts) {
    if (!byId.has(verdict.id)) byId.set(verdict.id, verdict)
  }
  const applied: AppliedVerdicts = { findings: [], rejected: [], confirmed: 0, unverified: 0 }
  candidates.forEach((candidate, index) => {
    const verdict = byId.get(index + 1)
    if (verdict === undefined) {
      applied.unverified++
      applied.findings.push(candidate)
    } else if (verdict.verdict === 'rejected') {
      applied.rejected.push({ ...candidate, reason: verdict.reason })
    } else {
      applied.confirmed++
      applied.findings.push({
        ...candidate,
        severity: verdict.severity,
        confidence: verdict.confidence,
      })
    }
  })
  return applied
}
