import type { LeftItem, LeftReason } from '../app/apply-file-suggestions.js'
import type { AiFix, FindingsFix } from '../app/fix-findings.js'
import type { LocalFixTarget } from '../app/local-fix.js'
import { singleLine, toTerminalText } from '../app/terminal-text.js'
import type { Severity } from '../review/types.js'
import { shortSha } from './review-text.js'
import { formatCount } from './units.js'

export interface ListedFinding {
  number: number
  finding: { severity?: Severity; file: string; line: number; title: string; suggestion?: unknown }
}

const LEFT_REASONS: Readonly<Record<LeftReason, string>> = {
  'no-suggestion': 'no suggestion',
  'not-found': 'the suggestion no longer matches the file',
  ambiguous: 'the suggested code appears more than once in the file',
  overlap: 'the suggestion overlaps one applied before it',
  'missing-file': 'the file is not in the working tree',
}

export function formatFixList(target: LocalFixTarget): string {
  return listed(
    `Findings of run ${target.run} (${singleLine(`${target.repo}@${target.branch}`)}):`,
    target.findings,
  )
}

export function listed(heading: string, findings: readonly ListedFinding[]): string {
  const lines = findings.map((item) => {
    const severity = item.finding.severity === undefined ? '' : `${item.finding.severity} `
    const suggestion = item.finding.suggestion === undefined ? '' : ' (suggestion)'
    return `${item.number}. ${severity}${place(item)}${suggestion}`
  })
  return `${[heading, ...lines].join('\n')}\n`
}

export function formatFixReport(fix: FindingsFix<ListedFinding>): string {
  const applied =
    fix.applied.length === 0
      ? 'Applied no suggestion.'
      : `Applied ${formatCount(fix.applied.length, 'suggestion')}: ${fix.applied.map(({ number }) => number).join(', ')}.`
  const changed = `Changed ${files(fix.changedFiles)}`
  if (fix.ai?.status !== 'answered') {
    const aiChanged =
      fix.ai === undefined || fix.ai.changedFiles.length === 0
        ? []
        : [`${fix.ai.provider} changed ${files(fix.ai.changedFiles)} before it failed`]
    return `${[applied, changed, ...aiChanged, ...leftLines(fix.left.map(suggestionLeft))].join('\n')}\n`
  }
  const { ai } = fix
  const outcomes = new Map(ai.outcomes.map((outcome) => [outcome.number, outcome]))
  const fixed = fix.left.flatMap(({ item, reason }) => {
    const outcome = outcomes.get(item.number)
    return outcome?.status === 'fixed'
      ? [`${item.number}. ${place(item)}${unapplied(reason)}${because(outcome.reason)}`]
      : []
  })
  const left = fix.left.flatMap(({ item, reason }): Left<ListedFinding>[] => {
    const outcome = outcomes.get(item.number)
    if (outcome?.status === 'fixed') return []
    return [
      {
        item,
        unapplied: unapplied(reason),
        why:
          outcome === undefined
            ? `${ai.provider} did not say`
            : `skipped by ${ai.provider}${because(outcome.reason)}`,
      },
    ]
  })
  return `${[
    applied,
    changed,
    `${ai.provider} changed ${files(ai.changedFiles)}`,
    ...(fixed.length === 0
      ? [`${ai.provider} fixed no finding.`]
      : [`${ai.provider} fixed ${formatCount(fixed.length, 'finding')}:`, ...fixed]),
    ...leftLines(left),
    ...(ai.summary === '' ? [] : [`Summary of ${ai.provider}:`, toTerminalText(ai.summary)]),
  ].join('\n')}\n`
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

function aiWarnings(ai: Extract<AiFix, { status: 'answered' }>): string[] {
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
