import { z } from 'zod'
import type { CiSummary } from '../context/types.js'
import type { Finding, RecheckVerdict, ReviewResult } from '../review/types.js'

const SuggestionSchema = z.object({
  startLine: z.number(),
  endLine: z.number(),
  original: z.string(),
  replacement: z.string(),
})

const FindingSchema = z.object({
  severity: z.enum(['P0', 'P1', 'P2']),
  confidence: z.number(),
  file: z.string(),
  line: z.number(),
  title: z.string(),
  why: z.string(),
  fix: z.string().nullable(),
  rule: z.string().nullable(),
  sources: z.array(z.string()),
  reason: z.string().nullable(),
  suggestion: SuggestionSchema.nullable(),
  skill: z.string(),
  scope: z.enum(['change', 'repository']),
  closeToCut: z.boolean(),
})

const ReviewSchema = z.object({
  score: z.object({
    value: z.union([
      z.literal(0),
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
    ]),
    reason: z.string(),
  }),
  summary: z.string(),
  claims: z.array(
    z.object({
      claim: z.string(),
      verdict: z.enum(['confirmed', 'contradicted', 'unverified']),
      evidence: z.string(),
    }),
  ),
  files: z.array(z.object({ path: z.string(), change: z.string(), findings: z.number() })),
  findings: z.array(FindingSchema),
  debt: z.array(FindingSchema),
  worthChecking: z.array(FindingSchema),
  worthCheckingOmitted: z.number(),
  minConfidence: z.number(),
  dropped: z.object({
    invalid: z.number(),
    belowFloor: z.number(),
    outsideDiff: z.number(),
    duplicate: z.number(),
    rejected: z.number(),
    debt: z.number(),
  }),
  provider: z.object({ id: z.string(), model: z.string().nullable() }),
  durationMs: z.number(),
  skillBodies: z.array(z.object({ skill: z.string(), text: z.string() })).nullable(),
  language: z.string().nullable(),
  diffFingerprint: z.string().nullable(),
  ignored: z.array(z.string()),
})

const VerdictSchema = z.object({
  threadId: z.string(),
  file: z.string(),
  line: z.number().nullable(),
  title: z.string(),
  verdict: z.enum(['fixed', 'still-valid', 'unsure']),
  reason: z.string(),
  by: z.enum(['ai', 'unchanged', 'no-access']),
})

const StoredSchema = z.object({
  pullRequest: z.object({
    repo: z.string(),
    number: z.number(),
    url: z.string(),
    title: z.string(),
    headSha: z.string(),
  }),
  review: ReviewSchema,
  publication: z.object({
    status: z.literal('dry-run'),
    wouldResolve: z.array(VerdictSchema),
  }),
  ci: z
    .object({
      state: z.enum(['none', 'pending', 'passing', 'failing']),
      total: z.number(),
      failing: z.array(z.string()),
      pending: z.array(z.string()),
    })
    .nullable(),
})

export interface StoredReview {
  pullRequest: { repo: string; number: number; url: string; title: string; headSha: string }
  result: ReviewResult
  language?: string
  ci?: CiSummary
  wouldResolve: RecheckVerdict[]
}

export function storedReview(json: unknown): StoredReview | undefined {
  const parsed = StoredSchema.safeParse(json)
  if (!parsed.success) return undefined
  const { pullRequest, review, publication, ci } = parsed.data
  const { provider, dropped, language, diffFingerprint, skillBodies } = review
  const result: ReviewResult = {
    target: {
      repo: pullRequest.repo,
      number: pullRequest.number,
      headSha: pullRequest.headSha,
      ...(diffFingerprint === null ? {} : { diffFingerprint }),
    },
    providerId: provider.id,
    ...(provider.model === null ? {} : { model: provider.model }),
    durationMs: review.durationMs,
    passUsage: [],
    summary: review.summary,
    files: review.files,
    findings: review.findings.map(findingOf),
    ...(review.debt.length === 0 ? {} : { debt: review.debt.map(findingOf) }),
    worthChecking: review.worthChecking.map(findingOf),
    worthCheckingOmitted: review.worthCheckingOmitted,
    minConfidence: review.minConfidence,
    score: review.score,
    dropped: {
      invalid: dropped.invalid,
      belowFloor: dropped.belowFloor,
      outsideDiff: dropped.outsideDiff,
      duplicate: dropped.duplicate,
      rejected: dropped.rejected,
      ...(dropped.debt === 0 ? {} : { debt: dropped.debt }),
    },
    claims: review.claims,
    ...(review.ignored.length === 0 ? {} : { ignored: review.ignored }),
    ...(skillBodies === null || skillBodies.length === 0 ? {} : { skillBodies }),
  }
  return {
    pullRequest,
    result,
    ...(language === null ? {} : { language }),
    ...(ci === null ? {} : { ci }),
    wouldResolve: publication.wouldResolve,
  }
}

function findingOf(stored: z.infer<typeof FindingSchema>): Finding {
  const { rule, sources, reason, suggestion, scope, closeToCut } = stored
  return {
    severity: stored.severity,
    confidence: stored.confidence,
    file: stored.file,
    line: stored.line,
    title: stored.title,
    why: stored.why,
    fix: stored.fix,
    ...(rule === null ? {} : { rule }),
    ...(sources.length === 0 ? {} : { sources }),
    ...(reason === null ? {} : { reason }),
    ...(suggestion === null ? {} : { suggestion }),
    skill: stored.skill,
    ...(scope === 'repository' ? { scope } : {}),
    ...(closeToCut ? { closeToCut: true as const } : {}),
  }
}
