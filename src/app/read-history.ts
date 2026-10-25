import { destinationOf } from '../publish/feedback.js'
import type { Destination, SignalKind } from '../publish/feedback.js'
import type {
  FindingFilter,
  FindingRecord,
  HistoryFilter,
  HistoryStore,
  RunRecord,
} from '../store/history-store.js'

export type HistoryReader = Pick<HistoryStore, 'runs' | 'findings' | 'run'>

export interface FeedbackFinding extends FindingRecord {
  destination: Destination
  marks: SignalKind[]
}

export interface FeedbackCounts {
  published: number
  fixed: number
  dismissed: number
  ignored: number
  open: number
  negativeReaction: number
  humanReply: number
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
}

export interface StoredPublication {
  status: string
  url: string | null
  comments: number | null
}

export interface StoredCi {
  state: string
  failing: string[]
  pending: string[]
  checks: { name: string; state: string }[]
}

export interface ReviewDetail {
  run: RunRecord
  pullRequest: { url: string; title: string | null }
  verdict: NonNullable<RunRecord['verdict']> | null
  score: { value: number; reason: string | null } | null
  summary: string | null
  findings: StoredFinding[]
  worthChecking: StoredFinding[]
  publication: StoredPublication | null
  ci: StoredCi | null
  published: FeedbackFinding[]
}

export function readReviews(
  history: HistoryReader | undefined,
  filter: HistoryFilter,
): { runs: RunRecord[]; total: number } {
  return history?.runs(filter) ?? { runs: [], total: 0 }
}

export function readFindings(
  history: HistoryReader | undefined,
  filter: FindingFilter,
): FeedbackFinding[] {
  return (history?.findings(filter) ?? []).map(withFeedback)
}

export function readFeedbackStats(
  history: HistoryReader | undefined,
  filter: FindingFilter,
): { repos: RepoStats[]; rules: RuleStats[] } {
  const findings = history?.findings(filter) ?? []
  return { repos: feedbackStats(findings), rules: ruleStats(findings) }
}

export function feedbackStats(findings: readonly FindingRecord[]): RepoStats[] {
  return countBy(findings, (finding) => ({ repo: finding.repo })).sort((a, b) =>
    a.repo.localeCompare(b.repo),
  )
}

export function ruleStats(findings: readonly FindingRecord[]): RuleStats[] {
  return countBy(
    findings.filter((finding) => finding.rule !== undefined),
    (finding) => ({ repo: finding.repo, rule: finding.rule ?? '' }),
  ).sort((a, b) => a.repo.localeCompare(b.repo) || a.rule.localeCompare(b.rule))
}

export function readReviewDetail(
  history: HistoryReader | undefined,
  id: number,
): ReviewDetail | undefined {
  const stored = history?.run(id)
  if (history === undefined || stored === undefined) return undefined
  const { resultJson, ...run } = stored
  const result = objectOf(parseJson(resultJson))
  const pullRequest = objectOf(result?.pullRequest)
  const review = objectOf(result?.review)
  const score = objectOf(review?.score)
  const scoreValue = numberOf(score?.value) ?? run.score ?? null
  return {
    run,
    pullRequest: {
      url:
        stringOf(pullRequest?.url) ?? `https://github.com/${run.repo}/pull/${String(run.number)}`,
      title: stringOf(pullRequest?.title) ?? null,
    },
    verdict: run.verdict ?? null,
    score:
      scoreValue === null ? null : { value: scoreValue, reason: stringOf(score?.reason) ?? null },
    summary: stringOf(review?.summary) ?? null,
    findings: storedFindings(review?.findings),
    worthChecking: storedFindings(review?.worthChecking),
    publication: storedPublication(result?.publication),
    ci: storedCi(result?.ci),
    published: history
      .findings({ repo: run.repo, number: run.number })
      .filter((finding) => finding.runId === id)
      .map(withFeedback),
  }
}

function withFeedback(finding: FindingRecord): FeedbackFinding {
  const marks = finding.signals
    .filter((signal) => signal.clearedAt === undefined)
    .map(({ kind }) => kind)
  return { ...finding, destination: destinationOf(marks), marks }
}

function countBy<K extends { repo: string }>(
  findings: readonly FindingRecord[],
  keyOf: (finding: FindingRecord) => K,
): (K & FeedbackCounts)[] {
  const groups = new Map<string, K & FeedbackCounts>()
  for (const finding of findings) {
    const key = keyOf(finding)
    const id = JSON.stringify(key)
    const counts = groups.get(id) ?? { ...key, ...emptyCounts() }
    const { destination, marks } = withFeedback(finding)
    counts.published++
    counts[destination]++
    if (marks.includes('negative-reaction')) counts.negativeReaction++
    if (marks.includes('human-reply')) counts.humanReply++
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
  }
}

function storedFindings(value: unknown): StoredFinding[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): StoredFinding[] => {
    const finding = objectOf(item)
    const file = stringOf(finding?.file)
    const title = stringOf(finding?.title)
    if (finding === undefined || file === undefined || title === undefined) return []
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
      },
    ]
  })
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
  }
}

function storedCi(value: unknown): StoredCi | null {
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

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}
