import type { LocalRun } from '../app/local-review.js'
import { localRunName } from '../app/run-target.js'
import type { PullRequest } from '../github/pull-request.js'
import { numberFindings } from '../review/finding-numbers.js'
import { scoreFocus } from '../review/score.js'
import type { FileChange, Finding, ReviewResult, Severity, Suggestion } from '../review/types.js'
import { english } from './i18n/en.js'
import { debtItem } from './debt-text.js'
import { findingReferences, leftOutLine } from './finding-references.js'
import type { Messages } from './i18n/messages.js'
import { singleLine } from '../app/terminal-text.js'
import { blockText, cell, codeFence } from './markdown-text.js'
import { modelLabel, shortSha } from './review-text.js'
import { toTerminalText } from '../app/terminal-text.js'
import { formatBytes, formatCount, formatDuration, formatTokens } from './units.js'

const MAX_FILE_ROWS = 20
const SEVERITIES: readonly Severity[] = ['P0', 'P1', 'P2']

export function formatPullRequestSummary(pr: PullRequest): string {
  const { changedFiles, additions, deletions } = pr.stats
  const diffSize = formatBytes(Buffer.byteLength(pr.diff, 'utf8'))
  return [
    `${pr.repo}#${pr.number}`,
    shortSha(pr.headSha),
    formatCount(changedFiles, 'file'),
    `+${additions} −${deletions}`,
    `${diffSize} diff`,
  ].join(' · ')
}

export function formatReview(
  pr: PullRequest,
  result: ReviewResult,
  messages: Messages = english,
): string {
  const { terminal } = messages
  const header = [
    `# ${terminal.reviewOf} ${pr.repo}#${pr.number}: ${singleLine(pr.title)}`,
    `${pr.url} · ${terminal.head} ${shortSha(result.target.headSha)} · ${terminal.state(pr.state, pr.draft)}`,
  ]
  return reviewText(header, result, messages)
}

export type LocalHeader = Pick<LocalRun, 'repo' | 'branch' | 'base' | 'head' | 'dirty'>

export function formatLocalReviewStart(local: LocalHeader & Pick<LocalRun, 'baseRef'>): string {
  const name = `${local.repo}@${localRunName(local.branch, local.head)}${local.dirty ? ' + uncommitted' : ''}`
  return toTerminalText(`Reviewing ${name} against ${local.baseRef} (${shortSha(local.base)})…`)
}

export function formatLocalReview(
  local: LocalHeader,
  title: string,
  result: ReviewResult,
  messages: Messages = english,
): string {
  const { terminal } = messages
  const name = singleLine(localRunName(local.branch, local.head))
  const head = `${terminal.head} ${shortSha(local.head)}${local.dirty ? ` + ${terminal.uncommitted}` : ''}`
  const header = [
    `# ${terminal.reviewOf} ${local.repo}@${name} (${terminal.local}): ${singleLine(title)}`,
    `${terminal.base} ${shortSha(local.base)} · ${head}`,
  ]
  return reviewText(header, result, messages)
}

function reviewText(header: readonly string[], result: ReviewResult, messages: Messages): string {
  const sections = [
    header.join('\n'),
    scoreLine(result, messages),
    summarySection(result.summary, messages),
    filesSection(result.files, messages),
    findingsSection(result.findings, messages),
    worthCheckingSection(result, messages),
    rejectedSection(result, messages),
    debtSection(result.debt ?? [], messages),
    ['---', countsLine(result, messages), leftOut(result, messages), footer(result, messages)]
      .filter((line) => line !== '')
      .join('\n'),
  ]
  return `${sections.filter((section) => section !== '').join('\n\n')}\n`
}

function scoreLine({ score, findings, coverage }: ReviewResult, messages: Messages): string {
  const reason = messages.scoreReason(scoreFocus(findings))
  const label = coverage === undefined ? '' : messages.coverage(coverage)
  const line = `**${messages.terminal.score}: ${score.value}/5** (${messages.scoreLabels[score.value]}): ${singleLine(reason)}`
  return label === '' ? line : `${line} · ${label}`
}

function summarySection(summary: string, messages: Messages): string {
  const text = blockText(summary)
  return text === '' ? '' : `## ${messages.summary}\n\n${text}`
}

function filesSection(files: readonly FileChange[], messages: Messages): string {
  if (files.length === 0) return ''
  const rows = files
    .slice(0, MAX_FILE_ROWS)
    .map(({ path, change, findings }) => `| ${cell(path)} | ${cell(change)} | ${findings} |`)
  const hidden = files.length - MAX_FILE_ROWS
  const more = hidden > 0 ? [`\n+${messages.moreFiles(hidden)}`] : []
  return [
    `## ${messages.files}`,
    '',
    `| ${messages.fileColumns.join(' | ')} |`,
    '| --- | --- | --- |',
    ...rows,
    ...more,
  ].join('\n')
}

function findingsSection(findings: readonly Finding[], messages: Messages): string {
  if (findings.length === 0) return ''
  const numbered = numberFindings(findings)
  const groups = SEVERITIES.flatMap((severity) => {
    const group = numbered.filter(({ finding }) => finding.severity === severity)
    if (group.length === 0) return []
    return [
      [
        `### ${messages.terminal.severity[severity]}`,
        ...group.map(({ number, finding }) => findingItem(number, finding, messages)),
      ].join('\n\n'),
    ]
  })
  return [`## ${messages.terminal.findings}`, ...groups].join('\n\n')
}

function findingItem(number: number, finding: Finding, messages: Messages): string {
  const lines = [
    `${number}. **${singleLine(finding.file)}:${finding.line}**: ${singleLine(finding.title)} (${confidenceText(finding, messages)})`,
    indent(blockText(finding.why)),
  ]
  if (finding.fix !== null && finding.fix.trim() !== '') {
    lines.push(indent(`${messages.fix}: ${blockText(finding.fix)}`))
  }
  if (finding.suggestion !== undefined) lines.push(indent(suggestionDiff(finding.suggestion)))
  const references = findingReferences(finding, messages)
  if (references !== '') lines.push(indent(singleLine(references)))
  return lines.join('\n')
}

function confidenceText({ confidence, closeToCut }: Finding, messages: Messages): string {
  const text = `${messages.confidence} ${confidence}`
  return closeToCut === true ? `${text} · ${messages.terminal.closeToCut}` : text
}

function suggestionDiff({ original, replacement }: Suggestion): string {
  const lines = (prefix: string, code: string) =>
    code === ''
      ? []
      : toTerminalText(code.replace(/\n$/, ''))
          .split('\n')
          .map((line) => `${prefix}${line}`)
  const body = [...lines('-', original), ...lines('+', replacement)]
  const fence = codeFence(body.join('\n'))
  return [`${fence}diff`, ...body, fence].join('\n')
}

function worthCheckingSection(
  { worthChecking, worthCheckingOmitted, minConfidence }: ReviewResult,
  messages: Messages,
): string {
  if (worthChecking.length === 0) return ''
  const items = worthChecking.map(
    ({ severity, file, line, title, confidence }) =>
      `- **${severity}** · ${singleLine(file)}:${line}: ${singleLine(title)} (${messages.confidence} ${confidence})`,
  )
  if (worthCheckingOmitted > 0) items.push(`- ${messages.moreItems(worthCheckingOmitted)}`)
  return [`## ${messages.worthChecking(minConfidence)}`, '', ...items].join('\n')
}

function rejectedSection({ verification }: ReviewResult, messages: Messages): string {
  const rejected = verification?.rejected ?? []
  if (rejected.length === 0) return ''
  const items = rejected.map(
    ({ severity, file, line, title, confidence, reason }) =>
      `- **${severity}** · ${singleLine(file)}:${line}: ${singleLine(title)} (${messages.confidence} ${confidence}): ${singleLine(reason)}`,
  )
  return [`## ${messages.terminal.rejectedByVerification}`, '', ...items].join('\n')
}

function debtSection(debt: readonly Finding[], messages: Messages): string {
  if (debt.length === 0) return ''
  const items = debt.map((finding) => debtItem(finding, singleLine))
  return [`## ${messages.debt}`, '', messages.debtNote, '', ...items].join('\n')
}

function countsLine(
  { findings, worthChecking, worthCheckingOmitted, dropped }: ReviewResult,
  messages: Messages,
): string {
  const parts = [messages.terminal.findingCount(findings.length)]
  const close = findings.filter(({ closeToCut }) => closeToCut === true).length
  if (close > 0) parts.push(messages.terminal.closeToCutCount(close))
  const toCheck = worthChecking.length + worthCheckingOmitted
  if (toCheck > 0) parts.push(messages.terminal.worthCheckingCount(toCheck))
  const droppedPart = messages.dropped(dropped)
  if (droppedPart !== '') parts.push(droppedPart)
  return parts.join(' · ')
}

function leftOut(result: ReviewResult, messages: Messages): string {
  return singleLine(leftOutLine(result.ignored ?? [], messages))
}

function footer(result: ReviewResult, messages: Messages): string {
  const parts = [result.providerId]
  if (result.model !== undefined) parts.push(toTerminalText(modelLabel(result)))
  if (result.verification !== undefined) parts.push(messages.verification(result.verification))
  parts.push(formatDuration(result.durationMs))
  if (result.usage !== undefined) {
    const { inputTokens, outputTokens } = result.usage
    parts.push(messages.terminal.tokens(formatTokens(inputTokens), formatTokens(outputTokens)))
  }
  return parts.join(' · ')
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `   ${line}`)
    .join('\n')
}
