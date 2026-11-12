import type { Coverage, DiffGroupReport, Suggestion } from '../review/types.js'
import { numberOf, objectOf, parseJson, stringOf, stringsOf } from './stored-json.js'
import { groupsOf, passesOf, postedOf, reportBlocksOf } from './stored-report-blocks.js'
import type { PostedReview, ReportBlocks, StoredPasses } from './stored-report-blocks.js'
import { storedCoverage, storedSuggestion } from './stored-review.js'

export interface StoredFinding {
  severity: string | null
  confidence: number | null
  file: string
  line: number | null
  title: string
  why: string | null
  fix: string | null
  rule: string | null
  skill: string | null
  sources: string[]
  scope: 'change' | 'repository'
  closeToCut: boolean
  suggestion?: Suggestion
}

export interface StoredRunFinding extends Omit<StoredFinding, 'title'> {
  title: string | null
}

export interface StoredClaim {
  claim: string
  verdict: string
  evidence: string | null
}

export interface StoredCi {
  state: string
  failing: string[]
  pending: string[]
  checks: { name: string; state: string }[]
}

export interface StoredTokens {
  input: number
  cached: number | null
  output: number
}

export interface StoredPassUsage {
  pass: string
  skill: string | null
  group: string | null
  tokens: StoredTokens | null
}

export interface StoredUsage {
  passes: StoredPassUsage[]
  total: StoredTokens | null
}

export interface StoredRunReview {
  score: { value: number | null; reason: string | null }
  coverage: Coverage | null
  summary: string | null
  claims: StoredClaim[] | null
  findings: StoredRunFinding[] | null
  closeToCutMarked: boolean
  minConfidence: number | null
  debt: StoredRunFinding[] | null
  worthChecking: StoredRunFinding[] | null
  groups: DiffGroupReport[] | null
  passes: StoredPasses | null
  usage: StoredTokens | null
}

export interface StoredRunPublication {
  status: string | null
  url: string | null
  comments: number | null
  wouldResolve: number | null
  reason: string | null
  posted: PostedReview | null
}

export interface StoredRun extends Omit<ReportBlocks, 'ci'> {
  document: unknown
  status: string | null
  pullRequest: { url: string | null; title: string | null } | null
  localTitle: string | null
  publishedFrom: number | null
  review: StoredRunReview | null
  publication: StoredRunPublication | null
  ci: StoredCi | null
  everyCiCheckRead: boolean
  ciBlock: ReportBlocks['ci']
  usage: StoredUsage | null
}

export function readStoredRun(resultJson: string | undefined): StoredRun {
  const document = parseJson(resultJson)
  const json = objectOf(document) ?? {}
  const { ci: ciBlock, ...blocks } = reportBlocksOf(json)
  const pullRequest = json.pullRequest
  const ci = objectOf(json.ci)
  return {
    document,
    status: stringOf(json.status) ?? null,
    pullRequest:
      pullRequest === undefined || pullRequest === null ? null : pullRequestOf(pullRequest),
    localTitle: stringOf(objectOf(json.local)?.title) ?? null,
    publishedFrom: numberOf(json.publishedFrom) ?? null,
    review: reviewOf(json.review),
    publication: publicationOf(json.publication),
    ci: ci === undefined ? null : ciOf(ci),
    everyCiCheckRead: ci !== undefined && Array.isArray(ci.checks) && ci.checks.every(isCheck),
    ciBlock,
    ...blocks,
    usage: usageOf(json.usage),
  }
}

export function titledFindings(findings: readonly StoredRunFinding[]): StoredFinding[] {
  return findings.flatMap(({ title, ...finding }) =>
    title === null ? [] : [{ ...finding, title }],
  )
}

function pullRequestOf(value: unknown): StoredRun['pullRequest'] {
  const pullRequest = objectOf(value)
  return {
    url: stringOf(pullRequest?.url) ?? null,
    title: stringOf(pullRequest?.title) ?? null,
  }
}

function reviewOf(value: unknown): StoredRunReview | null {
  const review = objectOf(value)
  if (review === undefined) return null
  const score = objectOf(review.score)
  const findings = review.findings
  return {
    score: { value: numberOf(score?.value) ?? null, reason: stringOf(score?.reason) ?? null },
    coverage: storedCoverage(review.coverage) ?? null,
    summary: stringOf(review.summary) ?? null,
    claims: claimsOf(review.claims),
    findings: findingsOf(findings),
    closeToCutMarked:
      Array.isArray(findings) &&
      findings.every((finding) => typeof objectOf(finding)?.closeToCut === 'boolean'),
    minConfidence: numberOf(review.minConfidence) ?? null,
    debt: findingsOf(review.debt),
    worthChecking: findingsOf(review.worthChecking),
    groups: groupsOf(review.groups),
    passes: passesOf(review),
    usage: tokensOf(review.usage),
  }
}

function findingsOf(value: unknown): StoredRunFinding[] | null {
  if (!Array.isArray(value)) return null
  return value.flatMap((item): StoredRunFinding[] => {
    const finding = objectOf(item)
    const file = stringOf(finding?.file)
    if (finding === undefined || file === undefined) return []
    const suggestion = storedSuggestion(finding.suggestion)
    return [
      {
        severity: stringOf(finding.severity) ?? null,
        confidence: numberOf(finding.confidence) ?? null,
        file,
        line: numberOf(finding.line) ?? null,
        title: stringOf(finding.title) ?? null,
        why: stringOf(finding.why) ?? null,
        fix: stringOf(finding.fix) ?? null,
        rule: stringOf(finding.rule) ?? null,
        skill: stringOf(finding.skill) ?? null,
        sources: stringsOf(finding.sources),
        scope: finding.scope === 'repository' ? 'repository' : 'change',
        closeToCut: finding.closeToCut === true,
        ...(suggestion === undefined ? {} : { suggestion }),
      },
    ]
  })
}

function claimsOf(value: unknown): StoredClaim[] | null {
  if (!Array.isArray(value)) return null
  return value.flatMap((item): StoredClaim[] => {
    const claim = objectOf(item)
    const text = stringOf(claim?.claim)
    const verdict = stringOf(claim?.verdict)
    if (text === undefined || verdict === undefined) return []
    return [{ claim: text, verdict, evidence: stringOf(claim?.evidence) ?? null }]
  })
}

function publicationOf(value: unknown): StoredRunPublication | null {
  const publication = objectOf(value)
  if (publication === undefined) return null
  return {
    status: stringOf(publication.status) ?? null,
    url: stringOf(publication.url) ?? null,
    comments: Array.isArray(publication.comments)
      ? publication.comments.length
      : (numberOf(publication.comments) ?? null),
    wouldResolve: Array.isArray(publication.wouldResolve) ? publication.wouldResolve.length : null,
    reason:
      stringOf(publication.reason) ?? stringOf(objectOf(publication.wouldSkip)?.reason) ?? null,
    posted: postedOf(publication),
  }
}

function ciOf(ci: Record<string, unknown>): StoredCi | null {
  const state = stringOf(ci.state)
  if (state === undefined) return null
  const checks = Array.isArray(ci.checks) ? ci.checks : []
  return {
    state,
    failing: stringsOf(ci.failing),
    pending: stringsOf(ci.pending),
    checks: checks.flatMap((item) =>
      isCheck(item) ? [{ name: item.name, state: item.state }] : [],
    ),
  }
}

function isCheck(value: unknown): value is { name: string; state: string } {
  const check = objectOf(value)
  return stringOf(check?.name) !== undefined && stringOf(check?.state) !== undefined
}

function usageOf(value: unknown): StoredUsage | null {
  const usage = objectOf(value)
  if (usage === undefined) return null
  const passes = Array.isArray(usage.passes) ? usage.passes : []
  return {
    passes: passes.flatMap((item): StoredPassUsage[] => {
      const entry = objectOf(item)
      const pass = stringOf(entry?.pass)
      if (entry === undefined || pass === undefined) return []
      return [
        {
          pass,
          skill: stringOf(entry.skill) ?? null,
          group: stringOf(entry.group) ?? null,
          tokens: tokensOf(entry.usage),
        },
      ]
    }),
    total: tokensOf(usage.total),
  }
}

function tokensOf(value: unknown): StoredTokens | null {
  const usage = objectOf(value)
  const input = numberOf(usage?.inputTokens)
  const output = numberOf(usage?.outputTokens)
  if (input === undefined || output === undefined) return null
  return { input, cached: numberOf(usage?.cachedInputTokens) ?? null, output }
}
