import type { PullRequest } from '../github/pull-request.js'
import type { Finding, ReviewOutcome, ReviewResult } from '../review/types.js'

const SCHEMA_VERSION = 1

export function formatReviewJson(pr: PullRequest, outcome: ReviewOutcome): string {
  const pullRequest = {
    repo: pr.repo,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    headSha: pr.headSha,
    state: pr.state,
    draft: pr.draft,
  }
  const body =
    outcome.status === 'skipped'
      ? {
          schemaVersion: SCHEMA_VERSION,
          status: outcome.status,
          reason: outcome.reason,
          pullRequest,
        }
      : {
          schemaVersion: SCHEMA_VERSION,
          status: outcome.status,
          pullRequest,
          review: reviewJson(outcome.result),
        }
  return `${JSON.stringify(body, null, 2)}\n`
}

function reviewJson(result: ReviewResult) {
  const { score, dropped, usage } = result
  return {
    score: { value: score.value, reason: score.reason },
    summary: result.summary,
    files: result.files.map(({ path, change, findings }) => ({ path, change, findings })),
    findings: result.findings.map(findingJson),
    worthChecking: result.worthChecking.map(findingJson),
    worthCheckingOmitted: result.worthCheckingOmitted,
    minConfidence: result.minConfidence,
    dropped: {
      invalid: dropped.invalid,
      belowFloor: dropped.belowFloor,
      outsideDiff: dropped.outsideDiff,
      duplicate: dropped.duplicate,
    },
    provider: {
      id: result.providerId,
      model: result.model ?? null,
      additionalModels: result.additionalModels ?? [],
    },
    durationMs: result.durationMs,
    usage:
      usage === undefined
        ? null
        : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  }
}

function findingJson({ severity, confidence, file, line, title, why, fix }: Finding) {
  return { severity, confidence, file, line, title, why, fix }
}
