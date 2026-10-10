import type { PullRequest } from '../github/pull-request.js'
import { scoreFocus } from '../review/score.js'
import type { FileChange, Finding, ReviewResult, Severity } from '../review/types.js'
import { english } from './i18n/en.js'
import { findingReferences, leftOutLine } from './finding-references.js'
import type { Messages } from './i18n/messages.js'
import { blockText, cell, singleLine } from './markdown-text.js'
import { modelLabel, shortSha } from './review-text.js'
import { toTerminalText } from './terminal-text.js'
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
  const sections = [
    [
      `# ${terminal.reviewOf} ${pr.repo}#${pr.number}: ${singleLine(pr.title)}`,
      `${pr.url} · ${terminal.head} ${shortSha(result.target.headSha)} · ${terminal.state(pr.state, pr.draft)}`,
    ].join('\n'),
    scoreLine(result, messages),
    summarySection(result.summary, messages),
    filesSection(result.files, messages),
    findingsSection(result.findings, messages),
    worthCheckingSection(result, messages),
    ['---', countsLine(result, messages), leftOut(result, messages), footer(result, messages)]
      .filter((line) => line !== '')
      .join('\n'),
  ]
  return `${sections.filter((section) => section !== '').join('\n\n')}\n`
}

function scoreLine({ score, findings }: ReviewResult, messages: Messages): string {
  const reason = messages.scoreReason(scoreFocus(findings))
  return `**${messages.terminal.score}: ${score.value}/5** (${messages.scoreLabels[score.value]}): ${singleLine(reason)}`
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
  let number = 0
  const groups = SEVERITIES.flatMap((severity) => {
    const group = findings.filter((finding) => finding.severity === severity)
    if (group.length === 0) return []
    return [
      [
        `### ${messages.terminal.severity[severity]}`,
        ...group.map((finding) => findingItem(++number, finding, messages)),
      ].join('\n\n'),
    ]
  })
  return [`## ${messages.terminal.findings}`, ...groups].join('\n\n')
}

function findingItem(number: number, finding: Finding, messages: Messages): string {
  const lines = [
    `${number}. **${singleLine(finding.file)}:${finding.line}**: ${singleLine(finding.title)} (${messages.confidence} ${finding.confidence})`,
    indent(blockText(finding.why)),
  ]
  if (finding.fix !== null && finding.fix.trim() !== '') {
    lines.push(indent(`${messages.fix}: ${blockText(finding.fix)}`))
  }
  const references = findingReferences(finding, messages)
  if (references !== '') lines.push(indent(singleLine(references)))
  return lines.join('\n')
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

function countsLine(
  { findings, worthChecking, worthCheckingOmitted, dropped }: ReviewResult,
  messages: Messages,
): string {
  const parts = [messages.terminal.findingCount(findings.length)]
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
