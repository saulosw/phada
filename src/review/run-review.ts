import { randomBytes } from 'node:crypto'
import type { ReviewProvider } from '../providers/types.js'
import { parseDiffFiles } from './diff-lines.js'
import { parseReviewReport } from './parse-report.js'
import { buildReviewPrompt } from './prompt.js'
import { scoreFindings } from './score.js'
import { selectFindings, summarizeFiles } from './select-findings.js'
import type { ReviewOutcome, ReviewRequest } from './types.js'

export interface RunReviewDeps {
  provider: ReviewProvider
  createNonce?: () => string
}

export async function runReview(
  request: ReviewRequest,
  deps: RunReviewDeps,
): Promise<ReviewOutcome> {
  const { pullRequest } = request
  if (pullRequest.diff.trim() === '') return { status: 'skipped', reason: 'empty-diff' }

  const createNonce = deps.createNonce ?? randomNonce
  const { text, durationMs, model, additionalModels, usage } = await deps.provider.review(
    buildReviewPrompt(request, createNonce()),
  )
  const report = parseReviewReport(text)
  const diffFiles = parseDiffFiles(pullRequest.diff)
  const selection = selectFindings(report.findings, diffFiles)
  return {
    status: 'reviewed',
    result: {
      target: { repo: pullRequest.repo, number: pullRequest.number, headSha: pullRequest.headSha },
      providerId: deps.provider.id,
      ...(model === undefined ? {} : { model }),
      ...(additionalModels === undefined ? {} : { additionalModels }),
      durationMs,
      ...(usage === undefined ? {} : { usage }),
      summary: report.summary,
      files: summarizeFiles(report.files, selection.findings, diffFiles),
      findings: selection.findings,
      score: scoreFindings(selection.findings),
      dropped: {
        invalid: report.invalid,
        belowFloor: selection.belowFloor,
        outsideDiff: selection.outsideDiff,
        duplicate: selection.duplicate,
        belowCut: selection.belowCut,
      },
    },
  }
}

function randomNonce(): string {
  return randomBytes(6).toString('hex')
}
