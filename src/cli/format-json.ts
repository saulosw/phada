import type { BlockedCommand } from '../providers/types.js'
import type { RelatedReport } from '../app/related-report.js'
import type { Ci, ContextReport } from '../context/types.js'
import type { ImpactReport } from '../graph/report.js'
import type { InvestigationReport } from '../investigation/tools/report.js'
import type { PullRequest } from '../github/pull-request.js'
import type { TokenUsage } from '../providers/types.js'
import { byteLength } from '../context/byte-cut.js'
import { CI_LOG_TOTAL_BYTES, CI_MAX_ANNOTATIONS } from '../context/ci.js'
import { CONVERSATION_BUDGET_BYTES, conversationItemBytes } from '../publish/conversation.js'
import type { Conversation, SkipReason } from '../publish/types.js'
import type {
  CiCheck,
  ConversationItem,
  Finding,
  RecheckReport,
  RecheckVerdict,
  ReviewOutcome,
  ReviewResult,
  Verification,
} from '../review/types.js'

import { reviewVerdict } from '../review/verdict.js'
import type { GitHubReview } from './format-github.js'

const SCHEMA_VERSION = 1

export interface ReviewJsonBlocks {
  conversation?: Conversation
  ci?: Ci
}

export interface ResolvedCounts {
  resolved: number
  failed: number
  total: number
}

export type Publication =
  | {
      status: 'published'
      url: string
      comments: number
      stillOpen: number
      dismissed?: number
      resolved?: ResolvedCounts
    }
  | { status: 'failed'; error: string }
  | {
      status: 'dry-run'
      review: GitHubReview
      stillOpen: number
      dismissed?: number
      wouldSkip?: SkipReason
      wouldResolve?: RecheckVerdict[]
    }
  | { status: 'skipped'; reason: SkipReason }
  | { status: 'not-published' }
  | { status: 'superseded'; headSha: string }
  | { status: 'closed-or-draft' }

export function formatReviewJson(
  pr: PullRequest,
  outcome: ReviewOutcome,
  publication: Publication | null = null,
  context: ContextReport | null = null,
  investigation: InvestigationReport | null = null,
  impact: ImpactReport | null = null,
  related: RelatedReport | null = null,
  recheck: RecheckReport | null = null,
  fixFor?: (blocked: BlockedCommand) => string,
  blocks: ReviewJsonBlocks = {},
): string {
  const pullRequest = pullRequestJson(pr)
  const conversation =
    blocks.conversation === undefined ? null : conversationJson(blocks.conversation)
  const ci = blocks.ci === undefined ? null : ciJson(blocks.ci)
  const publicationBlock = publication === null ? null : publicationJson(publication)
  const contextBlock = context === null ? null : contextJson(context)
  const body =
    outcome.status === 'skipped'
      ? {
          schemaVersion: SCHEMA_VERSION,
          status: outcome.status,
          reason: outcome.reason,
          verdict: 'skipped',
          pullRequest,
          publication: publicationBlock,
          context: contextBlock,
          conversation,
          ci,
          investigation,
          impact,
          related: relatedJson(related),
          recheck: recheckJson(recheck),
        }
      : {
          schemaVersion: SCHEMA_VERSION,
          status: outcome.status,
          verdict: reviewVerdict(outcome.result),
          pullRequest,
          review: reviewJson(outcome.result, fixFor),
          publication: publicationBlock,
          context: contextBlock,
          conversation,
          ci,
          investigation,
          impact,
          related: relatedJson(related),
          recheck: recheckJson(recheck),
        }
  return `${JSON.stringify(body, null, 2)}\n`
}

export function formatAlreadyReviewedJson(pr: PullRequest, reason: SkipReason): string {
  const body = {
    schemaVersion: SCHEMA_VERSION,
    status: 'skipped',
    reason: 'already-reviewed',
    verdict: 'skipped',
    pullRequest: pullRequestJson(pr),
    publication: publicationJson({ status: 'skipped', reason }),
    context: null,
    conversation: null,
    ci: null,
    investigation: null,
    impact: null,
    related: null,
    recheck: null,
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

function conversationJson({ items, report }: Conversation) {
  return {
    count: report.items,
    omitted: report.omitted,
    resolved: report.resolved,
    bots: report.bots,
    truncated: report.truncated,
    budget: { limit: CONVERSATION_BUDGET_BYTES, used: report.bytes },
    items: items.map(conversationItemJson),
  }
}

function conversationItemJson(item: ConversationItem) {
  const { kind, at, author, role } = item
  const bytes = conversationItemBytes(item)
  switch (item.kind) {
    case 'comment':
      return { kind, at, author, role, bytes }
    case 'review':
      return { kind, at, author, role, state: item.state, bytes }
    case 'thread':
      return {
        kind,
        at,
        author,
        role,
        file: item.file,
        line: item.line,
        resolved: item.resolved,
        outdated: item.outdated,
        replies: item.replies?.length ?? 0,
        omittedReplies: item.omittedReplies ?? 0,
        bytes,
      }
  }
}

function ciJson({ checks, summary, report, warnings }: Ci) {
  return {
    state: summary.state,
    total: summary.total,
    failing: summary.failing,
    pending: summary.pending,
    checks: checks.map(checkJson),
    annotations: {
      sent: report.annotations,
      omitted: report.omittedAnnotations,
      limit: CI_MAX_ANNOTATIONS,
    },
    logs: { sent: report.logs, omitted: report.omittedLogs, limit: CI_LOG_TOTAL_BYTES },
    truncated: report.truncated,
    bytes: report.bytes,
    warnings: warnings ?? [],
  }
}

function checkJson({ name, state, conclusion, annotations, log }: CiCheck) {
  return {
    name,
    state,
    conclusion: conclusion ?? null,
    annotations: annotations?.length ?? 0,
    logBytes: log === undefined ? null : byteLength(log),
  }
}

function relatedJson(report: RelatedReport | null) {
  if (report === null) return null
  return {
    status: report.status,
    reason: report.reason ?? null,
    repositories: report.repositories.map((entry) => ({
      repo: entry.repo,
      origin: entry.origin,
      description: entry.description ?? null,
      commit: entry.commit ?? null,
      state: entry.state,
      count: entry.count ?? null,
      packages: entry.packages,
      graph: entry.graph,
      reason: entry.reason ?? null,
    })),
  }
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
      return {
        status,
        url,
        comments,
        stillOpen,
        dismissed: publication.dismissed ?? 0,
        resolved: publication.resolved ?? { resolved: 0, failed: 0, total: 0 },
      }
    }
    case 'failed':
      return { status: publication.status, error: publication.error }
    case 'dry-run':
      return {
        status: publication.status,
        body: publication.review.body,
        comments: publication.review.comments.map(({ path, startLine, line, body }) => ({
          path,
          ...(startLine === undefined ? {} : { startLine }),
          line,
          body,
        })),
        stillOpen: publication.stillOpen,
        dismissed: publication.dismissed ?? 0,
        wouldSkip: publication.wouldSkip === undefined ? null : skipJson(publication.wouldSkip),
        wouldResolve: (publication.wouldResolve ?? []).map(verdictJson),
      }
    case 'skipped':
      return { status: publication.status, ...skipJson(publication.reason) }
    case 'superseded':
      return { status: publication.status, headSha: publication.headSha }
    case 'not-published':
    case 'closed-or-draft':
      return { status: publication.status }
  }
}

function skipJson(reason: SkipReason) {
  return {
    reason: reason.kind,
    openThreads: reason.kind === 'open-threads' ? reason.openThreads : 0,
    ...(reason.kind === 'same-diff' ? { since: reason.since } : {}),
  }
}

function reviewJson(result: ReviewResult, fixFor?: (blocked: BlockedCommand) => string) {
  const { score, dropped } = result
  return {
    score: { value: score.value, reason: score.reason },
    summary: result.summary,
    claims: result.claims.map(({ claim, verdict, evidence }) => ({ claim, verdict, evidence })),
    files: result.files.map(({ path, change, findings }) => ({ path, change, findings })),
    findings: result.findings.map(findingJson),
    debt: (result.debt ?? []).map(findingJson),
    worthChecking: result.worthChecking.map(findingJson),
    worthCheckingOmitted: result.worthCheckingOmitted,
    minConfidence: result.minConfidence,
    dropped: {
      invalid: dropped.invalid,
      belowFloor: dropped.belowFloor,
      outsideDiff: dropped.outsideDiff,
      duplicate: dropped.duplicate,
      rejected: dropped.rejected,
      debt: dropped.debt ?? 0,
    },
    verification: result.verification === undefined ? null : verificationJson(result.verification),
    suggestions: result.suggestions ?? null,
    provider: {
      id: result.providerId,
      model: result.model ?? null,
      additionalModels: result.additionalModels ?? [],
    },
    durationMs: result.durationMs,
    usage: usageJson(result.usage),
    passes:
      result.passes?.map((pass) => ({
        skill: pass.skill,
        origin: pass.origin,
        status: pass.status,
        mode: pass.mode ?? 'text',
        durationMs: pass.durationMs,
        usage: usageJson(pass.usage),
        findings: pass.findings,
        reason: pass.reason ?? null,
        output: pass.output ?? null,
        captured: pass.captured ?? null,
        blocked: (pass.blocked ?? []).map((item) => ({
          tool: item.tool,
          input: item.input,
          fix: fixFor?.(item) ?? null,
        })),
      })) ?? null,
    skillBodies: result.skillBodies ?? null,
  }
}

function recheckJson(recheck: RecheckReport | null) {
  if (recheck === null) return null
  return {
    threads: recheck.threads,
    fixed: recheck.fixed,
    stillValid: recheck.stillValid,
    unsure: recheck.unsure,
    verdicts: recheck.verdicts.map(verdictJson),
    durationMs: recheck.durationMs,
    usage: usageJson(recheck.usage),
  }
}

function verdictJson({ threadId, file, line, title, verdict, reason, by }: RecheckVerdict) {
  return { threadId, file, line, title, verdict, reason, by }
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

function findingJson(finding: Finding) {
  const {
    severity,
    confidence,
    file,
    line,
    title,
    why,
    fix,
    rule,
    sources,
    reason,
    suggestion,
    skill,
    scope,
    closeToCut,
  } = finding
  return {
    severity,
    confidence,
    file,
    line,
    title,
    why,
    fix,
    rule: rule ?? null,
    sources: sources ?? [],
    reason: reason ?? null,
    suggestion: suggestion ?? null,
    skill: skill ?? 'phada',
    scope: scope ?? 'change',
    closeToCut: closeToCut === true,
  }
}

export function contextJson(context: ContextReport) {
  return {
    configFiles: context.configFiles.map(({ path, origin, status, message }) => ({
      path,
      origin,
      status,
      ...(message === undefined ? {} : { message }),
    })),
    rules: context.rules.map(({ key, origin, scope, severity, status }) => ({
      key,
      origin,
      scope: [...scope],
      ...(severity === undefined ? {} : { severity }),
      status,
    })),
    docs: context.docs.map(({ path, origin, category, bytes, status, reason, scope }) => ({
      path,
      origin,
      category,
      bytes,
      status,
      ...(reason === undefined ? {} : { reason }),
      ...(scope === undefined ? {} : { scope: [...scope] }),
    })),
    ignored: [...context.ignored],
    budget: { limit: context.budget.limit, used: context.budget.used },
    warnings: [...context.warnings],
  }
}
