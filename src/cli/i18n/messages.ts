import type { CiState } from '../../context/types.js'
import type { ScoreFocus } from '../../review/score.js'
import type { DroppedFindings, ScoreValue, Severity, Verification } from '../../review/types.js'
import { english } from './en.js'
import { spanish } from './es.js'
import { portuguese } from './pt.js'

export interface CiNames {
  count: number
  shown: readonly string[]
}

export interface Messages {
  scoreLabels: Readonly<Record<ScoreValue, string>>
  scoreReason(focus: ScoreFocus | undefined): string
  confidence: string
  fix: string
  basedOn: string
  leftOut: string
  rule: string
  skill: string
  ciCheck: string
  summary: string
  files: string
  fileColumns: readonly [string, string, string]
  moreFiles(count: number): string
  worthChecking(minConfidence: number): string
  debt: string
  debtNote: string
  moreItems(count: number): string
  dropped(dropped: DroppedFindings): string
  verification(verification: Verification): string
  terminal: {
    reviewOf: string
    head: string
    state(state: 'open' | 'closed', draft: boolean): string
    score: string
    findings: string
    severity: Readonly<Record<Severity, string>>
    findingCount(count: number): string
    worthCheckingCount(count: number): string
    closeToCut: string
    closeToCutCount(count: number): string
    tokens(input: string, output: string): string
  }
  github: {
    skillBody(skill: string): string
    inlineComments(bySeverity: string, count: number): string
    stillOpenCount(count: number): string
    stillOpen: string
    filesTruncated(count: number): string
    truncated: string
    allIgnoredTitle: string
    allIgnored(sha: string): string
    onlyStillOpenTitle: string
    onlyStillOpen(count: number, sha: string): string
    preview(index: number, total: number, place: string): string
    fixedThreads(count: number, sha: string): string
    resolvedReply(sha: string, reason: string): string
    ci(state: Exclude<CiState, 'none'>, total: number, failing: CiNames, pending: CiNames): string
  }
}

const CATALOGS: Readonly<Record<string, Messages>> = { en: english, pt: portuguese, es: spanish }

export function messagesFor(language: string | undefined): Messages {
  const base = language?.split('-', 1)[0]?.toLowerCase() ?? 'en'
  return CATALOGS[base] ?? english
}
