import type { LeftItem, LeftReason } from '../app/apply-file-suggestions.js'
import { leftAfterAi } from '../app/fix-findings.js'
import type { AiFix, FindingsFix } from '../app/fix-findings.js'
import type { LocalFixTarget } from '../app/local-fix.js'
import { singleLine, toTerminalText } from '../app/terminal-text.js'
import type { FixOutcome } from '../review/fix-outcomes.js'
import type { Severity } from '../review/types.js'
import { shortSha } from './review-text.js'
import { formatCount } from './units.js'

export interface ListedFinding {
  number: number
  finding: { severity?: Severity; file: string; line: number; title: string; suggestion?: unknown }
}

type AnsweredFix = Extract<AiFix, { status: 'answered' }>

const LEFT_REASONS: Readonly<Record<LeftReason, string>> = {
  'no-suggestion': 'no suggestion',
  'not-found': 'the suggestion no longer matches the file',
  ambiguous: 'the suggested code appears more than once in the file',
  overlap: 'the suggestion overlaps one applied before it',
  'missing-file': 'the file is not in the working tree',
}

export function formatFixList(target: LocalFixTarget): string {
  return formatNumberedList(
    `Findings of run ${target.run} (${singleLine(`${target.repo}@${target.branch}`)}):`,
    target.findings,
  )
}

export function formatNumberedList(heading: string, findings: readonly ListedFinding[]): string {
  const lines = findings.map((item) => {
    const severity = item.finding.severity === undefined ? '' : `${item.finding.severity} `
    const suggestion = item.finding.suggestion === undefined ? '' : ' (suggestion)'
    return `${item.number}. ${severity}${place(item)}${suggestion}`
  })
  return `${[heading, ...lines].join('\n')}\n`
}

export function formatFixReport(fix: FindingsFix<ListedFinding>): string {
  const lines = fix.ai?.status === 'answered' ? answeredLines(fix, fix.ai) : suggestionLines(fix)
  return `${lines.join('\n')}\n`
}

export function formatFixWarnings(fix: FindingsFix<ListedFinding>): string[] {
  if (fix.left.length === 0) return []
  if (fix.ai === undefined) {
    return [
      `Warning: phada fix applied only the suggestions: Claude Code or Codex edit the ${formatCount(fix.left.length, 'finding')} left.`,
    ]
  }
  return fix.ai.status === 'answered' ? aiWarnings(fix.ai) : []
}

function aiWarnings(ai: AnsweredFix): string[] {
  const { unreported, blocked } = ai
  return [
    ...(unreported.length === 0
      ? []
      : [
          `Warning: ${ai.provider} did not say what it did with ${unreported.length === 1 ? 'finding' : 'findings'} ${unreported.join(', ')}; check ${unreported.length === 1 ? 'it' : 'them'} in git diff.`,
        ]),
    ...(blocked.length === 0
      ? []
      : [
          `Warning: ${ai.provider} was refused ${formatCount(blocked.length, 'command')}: ${blocked.map(({ tool, input }) => singleLine(`${tool} ${input}`)).join(', ')}`,
        ]),
  ]
}

export function formatHeadMoved(target: LocalFixTarget): string {
  return `Warning: HEAD moved from ${shortSha(target.reviewedHead)} to ${shortSha(target.head)} since run ${target.run} reviewed it; suggestions apply only where the code still matches.`
}

interface Left<T> {
  item: T
  why: string
  unapplied?: string
}

function suggestionLines(fix: FindingsFix<ListedFinding>): string[] {
  const failedChanges =
    fix.ai === undefined || fix.ai.changedFiles.length === 0
      ? []
      : [`${fix.ai.provider} changed ${files(fix.ai.changedFiles)} before it failed`]
  return [...headLines(fix), ...failedChanges, ...leftLines(fix.left.map(suggestionLeft))]
}

function answeredLines(fix: FindingsFix<ListedFinding>, ai: AnsweredFix): string[] {
  const { fixed, left } = leftAfterAi(fix)
  return [
    ...headLines(fix),
    `${ai.provider} changed ${files(ai.changedFiles)}`,
    ...fixedLines(ai.provider, fixed),
    ...leftLines(
      left.map(({ item, reason, outcome }) => ({
        item,
        unapplied: unapplied(reason),
        why:
          outcome === undefined
            ? `${ai.provider} did not say`
            : `skipped by ${ai.provider}${because(outcome.reason)}`,
      })),
    ),
    ...(ai.summary === '' ? [] : [`Summary of ${ai.provider}:`, toTerminalText(ai.summary)]),
  ]
}

function headLines(fix: FindingsFix<ListedFinding>): string[] {
  const { applied } = fix
  return [
    applied.length === 0
      ? 'Applied no suggestion.'
      : `Applied ${formatCount(applied.length, 'suggestion')}: ${applied.map(({ number }) => number).join(', ')}.`,
    `Changed ${files(fix.changedFiles)}`,
  ]
}

function fixedLines(
  provider: string,
  fixed: readonly (LeftItem<ListedFinding> & { outcome: FixOutcome })[],
): string[] {
  if (fixed.length === 0) return [`${provider} fixed no finding.`]
  return [
    `${provider} fixed ${formatCount(fixed.length, 'finding')}:`,
    ...fixed.map(
      ({ item, reason, outcome }) =>
        `${item.number}. ${place(item)}${unapplied(reason)}${because(outcome.reason)}`,
    ),
  ]
}

function suggestionLeft<T>({ item, reason }: LeftItem<T>): Left<T> {
  return { item, why: LEFT_REASONS[reason] }
}

function unapplied(reason: LeftReason): string {
  return reason === 'no-suggestion' ? '' : ` (suggestion not applied: ${LEFT_REASONS[reason]})`
}

function leftLines(left: readonly Left<ListedFinding>[]): string[] {
  if (left.length === 0) return ['Left no finding.']
  return [
    `Left ${formatCount(left.length, 'finding')}:`,
    ...left.map(
      ({ item, why, unapplied = '' }) => `${item.number}. ${place(item)}${unapplied}: ${why}`,
    ),
  ]
}

function files(paths: readonly string[]): string {
  return paths.length === 0
    ? 'no file.'
    : `${formatCount(paths.length, 'file')}: ${paths.map(singleLine).join(', ')}`
}

function because(reason: string): string {
  return reason === '' ? '' : `: ${singleLine(reason)}`
}

function place({ finding }: ListedFinding): string {
  return `${singleLine(finding.file)}:${finding.line} ${singleLine(finding.title)}`
}
