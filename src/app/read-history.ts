import { destinationOf } from '../publish/feedback.js'
import { noReplies, repliedKinds } from './reply-kinds.js'
import type { ReplyCounts } from './reply-kinds.js'
import { numberOf, objectOf, parseJson, stringOf, stringsOf } from './stored-json.js'
import { storedCoverage, storedSuggestion } from './stored-review.js'
import type { CoverageGapKind, CoverageLevel, Suggestion } from '../review/types.js'
import type { Destination, SignalKind } from '../publish/feedback.js'
import type {
  ClassifiedReply,
  FindingFilter,
  FindingRecord,
  HistoryFilter,
  HistoryStore,
  ListedRun,
  RunRecord,
} from '../store/history-store.js'

export type { HistoryFilter, ListedRun, RunRecord } from '../store/history-store.js'

export type HistoryReader = Pick<HistoryStore, 'runs' | 'findings' | 'run' | 'replies'>

export type { ReplyCounts } from './reply-kinds.js'

export interface FeedbackFinding extends FindingRecord {
  destination: Destination
  marks: SignalKind[]
  replies: ReplyCounts
}

export interface FeedbackCounts {
  published: number
  fixed: number
  dismissed: number
  ignored: number
  open: number
  negativeReaction: number
  humanReply: number
  replies: ReplyCounts
}

export interface RepoStats extends FeedbackCounts {
  repo: string
}

export interface RuleStats extends FeedbackCounts {
  repo: string
  rule: string
}

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

export interface StoredClaim {
  claim: string
  verdict: string
  evidence: string | null
}

export interface StoredPublication {
  status: string
  url: string | null
  comments: number | null
  wouldResolve: number | null
  reason: string | null
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

export interface StoredGroups {
  directory: number
  single: number
  failed: number
}

export interface StoredUsage {
  passes: StoredPassUsage[]
  total: StoredTokens | null
}

export interface StoredCoverage {
  level: CoverageLevel
  covered: number
  total: number
  verified: boolean
  gaps: { missing: number; notCompared: number; skipped: number }
}

export interface ReviewDetail {
  run: RunRecord
  pullRequest: { url: string | null; title: string | null }
  verdict: NonNullable<RunRecord['verdict']> | null
  score: { value: number; reason: string | null } | null
  coverage: StoredCoverage | null
  summary: string | null
  claims: StoredClaim[]
  findings: StoredFinding[]
  debt: StoredFinding[]
  worthChecking: StoredFinding[]
  publication: StoredPublication | null
  ci: StoredCi | null
  groups: StoredGroups | null
  usage: StoredUsage | null
  published: FeedbackFinding[]
}

export function readReviews(
  history: HistoryReader | undefined,
  filter: HistoryFilter,
): { runs: ListedRun[]; total: number } {
  return history?.runs(filter) ?? { runs: [], total: 0 }
}

export function readFindings(
  history: Pick<HistoryReader, 'findings' | 'replies'> | undefined,
  filter: FindingFilter,
): FeedbackFinding[] {
  if (history === undefined) return []
  return feedbackOf(history.findings(filter), history.replies(replyFilterOf(filter)))
}

export function readFeedbackStats(
  history: Pick<HistoryReader, 'findings' | 'replies'> | undefined,
  filter: FindingFilter,
): { repos: RepoStats[]; rules: RuleStats[] } {
  const findings = history?.findings(filter) ?? []
  const replies = history?.replies(replyFilterOf(filter)) ?? []
  return { repos: feedbackStats(findings, replies), rules: ruleStats(findings, replies) }
}

export function feedbackStats(
  findings: readonly FindingRecord[],
  replies: readonly ClassifiedReply[] = [],
): RepoStats[] {
  return countBy(feedbackOf(findings, replies), (finding) => ({ repo: finding.repo })).sort(
    (a, b) => a.repo.localeCompare(b.repo),
  )
}

export function ruleStats(
  findings: readonly FindingRecord[],
  replies: readonly ClassifiedReply[] = [],
): RuleStats[] {
  return countBy(
    feedbackOf(
      findings.filter((finding) => finding.rule !== undefined),
      replies,
    ),
    (finding) => ({ repo: finding.repo, rule: finding.rule ?? '' }),
  ).sort((a, b) => a.repo.localeCompare(b.repo) || a.rule.localeCompare(b.rule))
}

export function readReviewDetail(
  history: HistoryReader | undefined,
  id: number,
): ReviewDetail | undefined {
  const stored = history?.run(id)
  if (history === undefined || stored === undefined) return undefined
  const pull = { repo: stored.repo, number: stored.number }
  return reviewDetailOf(
    stored,
    feedbackOf(
      history.findings(pull).filter((finding) => finding.runId === id),
      history.replies(pull),
    ),
  )
}

export function reviewDetailOf(stored: RunRecord, published: FeedbackFinding[]): ReviewDetail {
  const { resultJson, ...run } = stored
  const result = objectOf(parseJson(resultJson))
  const pullRequest = objectOf(result?.pullRequest)
  const local = objectOf(result?.local)
  const review = objectOf(result?.review)
  const score = objectOf(review?.score)
  const scoreValue = numberOf(score?.value) ?? run.score ?? null
  return {
    run,
    pullRequest: {
      url:
        run.source === 'local'
          ? null
          : (stringOf(pullRequest?.url) ??
            `https://github.com/${run.repo}/pull/${String(run.number)}`),
      title: stringOf(pullRequest?.title) ?? stringOf(local?.title) ?? null,
    },
    verdict: run.verdict ?? null,
    score:
      scoreValue === null ? null : { value: scoreValue, reason: stringOf(score?.reason) ?? null },
    coverage: coverageSummary(review?.coverage),
    summary: stringOf(review?.summary) ?? null,
    claims: storedClaims(review?.claims),
    findings: storedFindings(review?.findings),
    debt: storedFindings(review?.debt),
    worthChecking: storedFindings(review?.worthChecking),
    publication: storedPublication(result?.publication),
    ci: storedCi(result?.ci),
    groups: storedGroups(review?.groups),
    usage: storedUsage(result?.usage, review?.usage),
    published,
  }
}

function feedbackOf(
  findings: readonly FindingRecord[],
  replies: readonly ClassifiedReply[],
): FeedbackFinding[] {
  const byThread = new Map<string, ReplyCounts>()
  for (const { threadId, kind } of replies) {
    const counts = byThread.get(threadId) ?? noReplies()
    counts[kind]++
    byThread.set(threadId, counts)
  }
  return findings.map((finding) => {
    const marks = finding.signals
      .filter((signal) => signal.clearedAt === undefined)
      .map(({ kind }) => kind)
    const replies = finding.threadId === undefined ? undefined : byThread.get(finding.threadId)
    return { ...finding, destination: destinationOf(marks), marks, replies: replies ?? noReplies() }
  })
}

function replyFilterOf({ repo, number }: FindingFilter): { repo?: string; number?: number } {
  return {
    ...(repo === undefined ? {} : { repo }),
    ...(number === undefined ? {} : { number }),
  }
}

function countBy<K extends { repo: string }>(
  findings: readonly FeedbackFinding[],
  keyOf: (finding: FeedbackFinding) => K,
): (K & FeedbackCounts)[] {
  const groups = new Map<string, K & FeedbackCounts>()
  for (const finding of findings) {
    const key = keyOf(finding)
    const id = JSON.stringify(key)
    const counts = groups.get(id) ?? { ...key, ...emptyCounts() }
    const { destination, marks, replies } = finding
    counts.published++
    counts[destination]++
    if (marks.includes('negative-reaction')) counts.negativeReaction++
    if (marks.includes('human-reply')) counts.humanReply++
    for (const { kind } of repliedKinds(replies)) counts.replies[kind]++
    groups.set(id, counts)
  }
  return [...groups.values()]
}

function emptyCounts(): FeedbackCounts {
  return {
    published: 0,
    fixed: 0,
    dismissed: 0,
    ignored: 0,
    open: 0,
    negativeReaction: 0,
    humanReply: 0,
    replies: noReplies(),
  }
}

export function storedFindings(value: unknown): StoredFinding[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): StoredFinding[] => {
    const finding = objectOf(item)
    const file = stringOf(finding?.file)
    const title = stringOf(finding?.title)
    if (finding === undefined || file === undefined || title === undefined) return []
    const suggestion = storedSuggestion(finding.suggestion)
    return [
      {
        severity: stringOf(finding.severity) ?? null,
        confidence: numberOf(finding.confidence) ?? null,
        file,
        line: numberOf(finding.line) ?? null,
        title,
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

export function storedClaims(value: unknown): StoredClaim[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): StoredClaim[] => {
    const claim = objectOf(item)
    const text = stringOf(claim?.claim)
    const verdict = stringOf(claim?.verdict)
    if (text === undefined || verdict === undefined) return []
    return [{ claim: text, verdict, evidence: stringOf(claim?.evidence) ?? null }]
  })
}

function coverageSummary(value: unknown): StoredCoverage | null {
  const coverage = storedCoverage(value)
  if (coverage === undefined) return null
  const { level, covered, total, verified, gaps } = coverage
  const count = (kind: CoverageGapKind) => gaps.filter((gap) => gap.kind === kind).length
  return {
    level,
    covered,
    total,
    verified,
    gaps: {
      missing: count('missing'),
      notCompared: count('not-compared'),
      skipped: count('skipped'),
    },
  }
}

function storedPublication(value: unknown): StoredPublication | null {
  const publication = objectOf(value)
  const status = stringOf(publication?.status)
  if (publication === undefined || status === undefined) return null
  return {
    status,
    url: stringOf(publication.url) ?? null,
    comments: Array.isArray(publication.comments)
      ? publication.comments.length
      : (numberOf(publication.comments) ?? null),
    wouldResolve: Array.isArray(publication.wouldResolve) ? publication.wouldResolve.length : null,
    reason:
      stringOf(publication.reason) ?? stringOf(objectOf(publication.wouldSkip)?.reason) ?? null,
  }
}

export function storedCi(value: unknown): StoredCi | null {
  const ci = objectOf(value)
  const state = stringOf(ci?.state)
  if (ci === undefined || state === undefined) return null
  const checks = Array.isArray(ci.checks) ? ci.checks : []
  return {
    state,
    failing: stringsOf(ci.failing),
    pending: stringsOf(ci.pending),
    checks: checks.flatMap((item) => {
      const check = objectOf(item)
      const name = stringOf(check?.name)
      const checkState = stringOf(check?.state)
      return name === undefined || checkState === undefined ? [] : [{ name, state: checkState }]
    }),
  }
}

function storedUsage(value: unknown, reviewTotal: unknown): StoredUsage | null {
  const usage = objectOf(value)
  if (usage === undefined) {
    const total = storedTokens(reviewTotal)
    return total === null ? null : { passes: [], total }
  }
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
          tokens: storedTokens(entry.usage),
        },
      ]
    }),
    total: storedTokens(usage.total),
  }
}

function storedGroups(value: unknown): StoredGroups | null {
  if (!Array.isArray(value)) return null
  const groups = value.flatMap((item) => {
    const group = objectOf(item)
    return group === undefined || stringOf(group.label) === undefined ? [] : [group]
  })
  if (groups.length === 0) return null
  return {
    directory: groups.filter(({ link }) => link !== 'single').length,
    single: groups.filter(({ link }) => link === 'single').length,
    failed: groups.filter(({ failed }) => failed === true).length,
  }
}

function storedTokens(value: unknown): StoredTokens | null {
  const usage = objectOf(value)
  const input = numberOf(usage?.inputTokens)
  const output = numberOf(usage?.outputTokens)
  if (input === undefined || output === undefined) return null
  return { input, cached: numberOf(usage?.cachedInputTokens) ?? null, output }
}
