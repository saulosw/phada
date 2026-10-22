import { destinationOf } from '../publish/feedback.js'
import type { Destination, SignalKind } from '../publish/feedback.js'
import type { FindingRecord, RunRecord } from '../store/history-store.js'
import { toTerminalText } from './terminal-text.js'
import { singleLine } from './markdown-text.js'
import { shortSha } from './review-text.js'
import { formatCount, formatLocalTime } from './units.js'

const SCHEMA_VERSION = 1
const WARNING = 'Signals, not verdicts: a dismissed finding may still have been right.'

export interface RepoStats {
  repo: string
  published: number
  fixed: number
  dismissed: number
  ignored: number
  open: number
  negativeReaction: number
  humanReply: number
}

export function formatHistoryText(
  runs: readonly RunRecord[],
  total: number,
  findings: readonly FindingRecord[] | undefined,
): string {
  if (runs.length === 0 && (findings ?? []).length === 0) return 'No reviews in the history yet.\n'
  const lines = runs.map(runLine)
  if (total > runs.length) {
    lines.push(`Showing ${runs.length} of ${total} reviews; use --limit or --since for more.`)
  }
  if (findings !== undefined && findings.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('Findings:', ...findings.map(findingLine))
  }
  return `${lines.map((line) => toTerminalText(line)).join('\n')}\n`
}

export function formatHistoryJson(
  runs: readonly RunRecord[],
  total: number,
  findings: readonly FindingRecord[],
): string {
  return `${JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      total,
      runs: runs.map(runJson),
      findings: findings.map(findingJson),
    },
    null,
    2,
  )}\n`
}

export function feedbackStats(findings: readonly FindingRecord[]): RepoStats[] {
  const byRepo = new Map<string, RepoStats>()
  for (const finding of findings) {
    const stats = byRepo.get(finding.repo) ?? emptyStats(finding.repo)
    const kinds = currentKinds(finding)
    stats.published++
    stats[destinationOf(kinds)]++
    if (kinds.includes('negative-reaction')) stats.negativeReaction++
    if (kinds.includes('human-reply')) stats.humanReply++
    byRepo.set(finding.repo, stats)
  }
  return [...byRepo.values()].sort((a, b) => a.repo.localeCompare(b.repo))
}

export function formatStatsText(stats: readonly RepoStats[], since: string | undefined): string {
  const lines = [
    ...(since === undefined ? [] : [`Since ${formatLocalTime(new Date(since)).slice(0, 10)}.`]),
    ...(stats.length === 0 ? ['No published comments in the history yet.'] : []),
    ...stats.map(statsLine),
    '',
    WARNING,
  ]
  return `${lines.map((line) => toTerminalText(line)).join('\n')}\n`
}

export function formatStatsJson(stats: readonly RepoStats[], since: string | undefined): string {
  return `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, since: since ?? null, repos: stats }, null, 2)}\n`
}

function runLine(run: RunRecord): string {
  const provider = run.model === undefined ? run.provider : `${run.provider}/${run.model}`
  const details = [
    provider,
    run.score === undefined ? undefined : `score ${run.score}`,
    run.findings === undefined ? undefined : formatCount(run.findings, 'finding'),
    run.url ?? run.reason ?? run.error,
  ].flatMap((part) => (part === undefined ? [] : [singleLine(part)]))
  return [
    formatLocalTime(new Date(run.startedAt)),
    `${run.repo}#${run.number}`,
    shortSha(run.headSha),
    run.source.padEnd(6),
    run.status.padEnd(9),
    details.join(' · '),
  ].join('  ')
}

function findingLine(finding: FindingRecord): string {
  const kinds = currentKinds(finding)
  const marks = [
    destinationOf(kinds),
    ...(finding.outdated ? ['outdated'] : []),
    ...(kinds.includes('negative-reaction') ? ['negative reaction'] : []),
    ...(kinds.includes('human-reply') ? ['replied'] : []),
  ]
  const where = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`
  return `  ${finding.severity ?? '--'}  ${singleLine(where)}  ${singleLine(finding.title)}  ${marks.join(' · ')}`
}

function statsLine(stats: RepoStats): string {
  const share = (count: number) =>
    count === 0 ? '0' : `${count} (${Math.round((count / stats.published) * 100)}%)`
  const destinations: Destination[] = ['fixed', 'dismissed', 'ignored', 'open']
  return [
    `${stats.repo}: ${formatCount(stats.published, 'comment')}`,
    ...destinations.map((destination) => `${destination} ${share(stats[destination])}`),
    `negative reaction ${stats.negativeReaction}`,
    `replied ${stats.humanReply}`,
  ].join(' · ')
}

function runJson(run: RunRecord) {
  return {
    id: run.id ?? null,
    jobId: run.jobId ?? null,
    source: run.source,
    repo: run.repo,
    number: run.number,
    headSha: run.headSha,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
    aiCalled: run.aiCalled,
    provider: run.provider ?? null,
    model: run.model ?? null,
    score: run.score ?? null,
    findings: run.findings ?? null,
    url: run.url ?? null,
    reason: run.reason ?? null,
    errorKind: run.errorKind ?? null,
    error: run.error ?? null,
  }
}

function findingJson(finding: FindingRecord) {
  return {
    repo: finding.repo,
    number: finding.number,
    file: finding.file,
    line: finding.line ?? null,
    title: finding.title,
    severity: finding.severity ?? null,
    confidence: finding.confidence ?? null,
    rule: finding.rule ?? null,
    commitSha: finding.commitSha ?? null,
    threadUrl: finding.threadUrl ?? null,
    publishedAt: finding.publishedAt,
    destination: destinationOf(currentKinds(finding)),
    outdated: finding.outdated,
    signals: finding.signals.map(({ kind, source, observedAt, clearedAt }) => ({
      kind,
      source,
      observedAt,
      clearedAt: clearedAt ?? null,
    })),
  }
}

function currentKinds(finding: FindingRecord): SignalKind[] {
  return finding.signals.filter((signal) => signal.clearedAt === undefined).map(({ kind }) => kind)
}

function emptyStats(repo: string): RepoStats {
  return {
    repo,
    published: 0,
    fixed: 0,
    dismissed: 0,
    ignored: 0,
    open: 0,
    negativeReaction: 0,
    humanReply: 0,
  }
}
