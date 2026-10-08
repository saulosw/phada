import type { PullRequest } from '../github/pull-request.js'
import type { TokenUsage } from '../providers/types.js'
import type { SkipReason } from '../publish/types.js'
import type { Finding, ReviewOutcome, ReviewResult, Verification } from '../review/types.js'

import type { GitHubReview } from './format-github.js'

const SCHEMA_VERSION = 1

export type Publication =
  | { status: 'published'; url: string; comments: number; stillOpen: number }
  | { status: 'failed'; error: string }
  | { status: 'dry-run'; review: GitHubReview; stillOpen: number; wouldSkip?: SkipReason }
  | { status: 'skipped'; reason: SkipReason }

export function formatReviewJson(
  pr: PullRequest,
  outcome: ReviewOutcome,
  publication: Publication | null = null,
): string {
  const pullRequest = pullRequestJson(pr)
  const publicationBlock = publication === null ? null : publicationJson(publication)
  const body =
    outcome.status === 'skipped'
      ? {
          schemaVersion: SCHEMA_VERSION,
          status: outcome.status,
          reason: outcome.reason,
          pullRequest,
          publication: publicationBlock,
        }
      : {
          schemaVersion: SCHEMA_VERSION,
          status: outcome.status,
          pullRequest,
          review: reviewJson(outcome.result),
          publication: publicationBlock,
        }
  return `${JSON.stringify(body, null, 2)}\n`
}

export function formatAlreadyReviewedJson(pr: PullRequest, reason: SkipReason): string {
  const body = {
    schemaVersion: SCHEMA_VERSION,
    status: 'skipped',
    reason: 'already-reviewed',
    pullRequest: pullRequestJson(pr),
    publication: publicationJson({ status: 'skipped', reason }),
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

function pullRequestJson(pr: PullRequest) {
  return {
    repo: pr.repo,
    number: pr.number,
    url: pr.url,
    title: pr.title,
    headSha: pr.headSha,
    state: pr.state,
    draft: pr.draft,
  }
}

function publicationJson(publication: Publication) {
  switch (publication.status) {
    case 'published': {
      const { status, url, comments, stillOpen } = publication
      return { status, url, comments, stillOpen }
    }
    case 'failed':
      return { status: publication.status, error: publication.error }
    case 'dry-run':
      return {
        status: publication.status,
        body: publication.review.body,
        comments: publication.review.comments.map(({ path, line, body }) => ({ path, line, body })),
        stillOpen: publication.stillOpen,
        wouldSkip: publication.wouldSkip === undefined ? null : skipJson(publication.wouldSkip),
      }
    case 'skipped':
      return { status: publication.status, ...skipJson(publication.reason) }
  }
}

function skipJson(reason: SkipReason) {
  return {
    reason: reason.kind,
    openThreads: reason.kind === 'open-threads' ? reason.openThreads : 0,
  }
}

function reviewJson(result: ReviewResult) {
  const { score, dropped } = result
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
      rejected: dropped.rejected,
    },
    verification: result.verification === undefined ? null : verificationJson(result.verification),
    provider: {
      id: result.providerId,
      model: result.model ?? null,
      additionalModels: result.additionalModels ?? [],
    },
    durationMs: result.durationMs,
    usage: usageJson(result.usage),
  }
}

function verificationJson(verification: Verification) {
  return {
    candidates: verification.candidates,
    confirmed: verification.confirmed,
    unverified: verification.unverified,
    rejected: verification.rejected.map(findingJson),
    durationMs: verification.durationMs,
    usage: usageJson(verification.usage),
  }
}

function usageJson(usage: TokenUsage | undefined) {
  return usage === undefined
    ? null
    : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
}

function findingJson({ severity, confidence, file, line, title, why, fix, reason }: Finding) {
  return { severity, confidence, file, line, title, why, fix, reason: reason ?? null }
}
