import { destinationOf } from '../publish/feedback.js'
import { noReplies, repliedKinds } from './reply-kinds.js'
import type { ReplyCounts } from './reply-kinds.js'
import { readStoredRun, titledFindings } from './stored-run.js'
import type {
  StoredCi,
  StoredClaim,
  StoredFinding,
  StoredRunPublication,
  StoredTokens,
  StoredUsage,
} from './stored-run.js'
import type { Coverage, CoverageGapKind, CoverageLevel, DiffGroupReport } from '../review/types.js'
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

export interface StoredPublication {
  status: string
  url: string | null
  comments: number | null
  wouldResolve: number | null
  reason: string | null
}

export interface StoredGroups {
  directory: number
  single: number
  failed: number
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
  const view = readStoredRun(resultJson)
  const { review } = view
  const scoreValue = review?.score.value ?? run.score ?? null
  return {
    run,
    pullRequest: {
      url:
        run.source === 'local'
          ? null
          : (view.pullRequest?.url ?? `https://github.com/${run.repo}/pull/${String(run.number)}`),
      title: view.pullRequest?.title ?? view.localTitle,
    },
    verdict: run.verdict ?? null,
    score: scoreValue === null ? null : { value: scoreValue, reason: review?.score.reason ?? null },
    coverage: coverageSummary(review?.coverage ?? null),
    summary: review?.summary ?? null,
    claims: review?.claims ?? [],
    findings: titledFindings(review?.findings ?? []),
    debt: titledFindings(review?.debt ?? []),
    worthChecking: titledFindings(review?.worthChecking ?? []),
    publication: publicationOf(view.publication),
    ci: view.ci,
    groups: groupCounts(review?.groups ?? null),
    usage: view.usage ?? totalOnly(review?.usage ?? null),
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

function coverageSummary(coverage: Coverage | null): StoredCoverage | null {
  if (coverage === null) return null
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

function publicationOf(publication: StoredRunPublication | null): StoredPublication | null {
  if (publication === null || publication.status === null) return null
  const { status, url, comments, wouldResolve, reason } = publication
  return { status, url, comments, wouldResolve, reason }
}

function groupCounts(groups: DiffGroupReport[] | null): StoredGroups | null {
  if (groups === null || groups.length === 0) return null
  return {
    directory: groups.filter(({ link }) => link !== 'single').length,
    single: groups.filter(({ link }) => link === 'single').length,
    failed: groups.filter(({ failed }) => failed === true).length,
  }
}

function totalOnly(total: StoredTokens | null): StoredUsage | null {
  return total === null ? null : { passes: [], total }
}
