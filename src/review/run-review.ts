import { randomBytes } from 'node:crypto'
import type { ReviewProvider, TokenUsage } from '../providers/types.js'
import { withKnownReferences, withRuleSeverity } from './context-findings.js'
import { parseDiffFiles } from './diff-lines.js'
import { parseReviewReport } from './parse-report.js'
import { buildReviewPrompt } from './prompt.js'
import { scoreFindings } from './score.js'
import {
  CONFIDENCE_FLOOR,
  isConfidenceCut,
  MAX_CONFIDENCE,
  prepareCandidates,
  splitAtCut,
  summarizeFiles,
  VERIFY_CANDIDATE_FLOOR,
} from './select-findings.js'
import type { ReviewOutcome, ReviewRequest } from './types.js'
import { verifyCandidates } from './verify-findings.js'

export const DEFAULT_MIN_CONFIDENCE = 60

export interface RunReviewDeps {
  provider: ReviewProvider
  verifier?: ReviewProvider
  createNonce?: () => string
}

export async function runReview(
  request: ReviewRequest,
  deps: RunReviewDeps,
): Promise<ReviewOutcome> {
  const { pullRequest, minConfidence = DEFAULT_MIN_CONFIDENCE } = request
  if (!isConfidenceCut(minConfidence)) {
    throw new RangeError(
      `Invalid minConfidence ${minConfidence}: use an integer from ${CONFIDENCE_FLOOR} to ${MAX_CONFIDENCE}.`,
    )
  }
  if (pullRequest.diff.trim() === '') {
    const allIgnored = (request.context?.ignored.length ?? 0) > 0
    return { status: 'skipped', reason: allIgnored ? 'all-ignored' : 'empty-diff' }
  }

  const createNonce = deps.createNonce ?? randomNonce
  const { text, durationMs, model, additionalModels, usage } = await deps.provider.review(
    buildReviewPrompt(request, createNonce()),
  )
  const report = parseReviewReport(text)
  const diffFiles = parseDiffFiles(pullRequest.diff)
  const verify = request.verify === true
  const reported = withKnownReferences(
    report.findings,
    request.context,
    diffFiles.map((file) => file.path),
  )
  const prepared = prepareCandidates(
    reported,
    diffFiles,
    minConfidence,
    verify ? VERIFY_CANDIDATE_FLOOR : CONFIDENCE_FLOOR,
  )
  const checked = verify
    ? await verifyCandidates(
        request,
        prepared.candidates,
        deps.verifier ?? deps.provider,
        createNonce(),
      )
    : undefined
  const selection = splitAtCut(
    withRuleSeverity(checked?.findings ?? prepared.candidates, request.context),
    minConfidence,
  )
  const totalUsage = sumUsage(usage, checked?.verification.usage)
  const ignored = request.context?.ignored ?? []
  return {
    status: 'reviewed',
    result: {
      target: { repo: pullRequest.repo, number: pullRequest.number, headSha: pullRequest.headSha },
      providerId: deps.provider.id,
      ...(model === undefined ? {} : { model }),
      ...(additionalModels === undefined ? {} : { additionalModels }),
      durationMs: durationMs + (checked?.verification.durationMs ?? 0),
      ...(totalUsage === undefined ? {} : { usage: totalUsage }),
      summary: report.summary,
      files: summarizeFiles(report.files, selection.findings, diffFiles),
      findings: selection.findings,
      worthChecking: selection.worthChecking,
      worthCheckingOmitted: selection.worthCheckingOmitted,
      minConfidence,
      score: scoreFindings(selection.findings),
      dropped: {
        invalid: report.invalid,
        belowFloor: prepared.belowFloor + selection.belowFloor,
        outsideDiff: prepared.outsideDiff,
        duplicate: prepared.duplicate,
        rejected: checked?.verification.rejected.length ?? 0,
      },
      ...(checked === undefined ? {} : { verification: checked.verification }),
      ...(ignored.length === 0 ? {} : { ignored: [...ignored] }),
    },
  }
}

function sumUsage(
  review: TokenUsage | undefined,
  verification: TokenUsage | undefined,
): TokenUsage | undefined {
  if (review === undefined || verification === undefined) return review ?? verification
  return {
    inputTokens: review.inputTokens + verification.inputTokens,
    outputTokens: review.outputTokens + verification.outputTokens,
  }
}

function randomNonce(): string {
  return randomBytes(6).toString('hex')
}
