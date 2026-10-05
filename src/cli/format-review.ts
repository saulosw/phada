import type { PullRequest } from '../github/pull-request.js'
import { MIN_CONFIDENCE } from '../review/select-findings.js'
import type { FileChange, Finding, ReviewResult, ScoreValue, Severity } from '../review/types.js'
import { toTerminalText } from './terminal-text.js'
import { formatBytes, formatCount, formatDuration, formatTokens } from './units.js'

const SHORT_SHA_LENGTH = 7
const MAX_FILE_ROWS = 20
const SCORE_LABELS: Readonly<Record<ScoreValue, string>> = {
  5: 'ready to merge',
  4: 'minor polish needed',
  3: 'implementation issues',
  2: 'significant bugs',
  1: 'critical problems',
  0: 'critical problems',
}
const SEVERITY_HEADINGS: ReadonlyArray<readonly [Severity, string]> = [
  ['P0', 'P0 · Must fix'],
  ['P1', 'P1 · Should fix'],
  ['P2', 'P2 · Consider'],
]

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

export function formatReview(pr: PullRequest, result: ReviewResult): string {
  const state = pr.draft ? `${pr.state}, draft` : pr.state
  const sections = [
    [
      `# Review of ${pr.repo}#${pr.number}: ${singleLine(pr.title)}`,
      `${pr.url} · head ${shortSha(result.target.headSha)} · ${state}`,
    ].join('\n'),
    scoreLine(result),
    summarySection(result.summary),
    filesSection(result.files),
    findingsSection(result.findings),
    ['---', countsLine(result), footer(result)].join('\n'),
  ]
  return `${sections.filter((section) => section !== '').join('\n\n')}\n`
}

function scoreLine({ score }: ReviewResult): string {
  return `**Confidence score: ${score.value}/5** (${SCORE_LABELS[score.value]}): ${singleLine(score.reason)}`
}

function summarySection(summary: string): string {
  const text = toTerminalText(summary).trim()
  return text === '' ? '' : `## Summary\n\n${text}`
}

function filesSection(files: readonly FileChange[]): string {
  if (files.length === 0) return ''
  const rows = files
    .slice(0, MAX_FILE_ROWS)
    .map(({ path, change, findings }) => `| ${cell(path)} | ${cell(change)} | ${findings} |`)
  const hidden = files.length - MAX_FILE_ROWS
  const more = hidden > 0 ? [`\n+${formatCount(hidden, 'more file')}`] : []
  return [
    '## Files',
    '',
    '| File | Change | Findings |',
    '| --- | --- | --- |',
    ...rows,
    ...more,
  ].join('\n')
}

function findingsSection(findings: readonly Finding[]): string {
  if (findings.length === 0) return ''
  let number = 0
  const groups = SEVERITY_HEADINGS.flatMap(([severity, heading]) => {
    const group = findings.filter((finding) => finding.severity === severity)
    if (group.length === 0) return []
    return [
      [`### ${heading}`, ...group.map((finding) => findingItem(++number, finding))].join('\n\n'),
    ]
  })
  return ['## Findings', ...groups].join('\n\n')
}

function findingItem(number: number, finding: Finding): string {
  const lines = [
    `${number}. **${singleLine(finding.file)}:${finding.line}**: ${singleLine(finding.title)} (confidence ${finding.confidence})`,
    indent(toTerminalText(finding.why).trim()),
  ]
  if (finding.fix !== null && finding.fix.trim() !== '') {
    lines.push(indent(`Fix: ${toTerminalText(finding.fix).trim()}`))
  }
  return lines.join('\n')
}

function countsLine({ findings, dropped }: ReviewResult): string {
  const belowCut = dropped.belowFloor + dropped.belowCut
  const reasons: ReadonlyArray<readonly [number, string]> = [
    [dropped.outsideDiff, `${dropped.outsideDiff} outside the diff`],
    [dropped.duplicate, formatCount(dropped.duplicate, 'duplicate')],
    [belowCut, `${belowCut} below confidence ${MIN_CONFIDENCE}`],
    [dropped.invalid, `${dropped.invalid} invalid`],
  ]
  const shown = reasons.filter(([count]) => count > 0)
  const total = shown.reduce((sum, [count]) => sum + count, 0)
  const droppedText =
    total === 0 ? '' : ` · ${total} dropped (${shown.map(([, text]) => text).join(', ')})`
  return `${formatCount(findings.length, 'finding')}${droppedText}`
}

function footer(result: ReviewResult): string {
  const parts = [result.providerId]
  if (result.model !== undefined) parts.push(toTerminalText(modelLabel(result)))
  parts.push(formatDuration(result.durationMs))
  if (result.usage !== undefined) {
    const { inputTokens, outputTokens } = result.usage
    parts.push(`${formatTokens(inputTokens)} in / ${formatTokens(outputTokens)} out`)
  }
  return parts.join(' · ')
}

function modelLabel({ model, additionalModels }: ReviewResult): string {
  if (additionalModels === undefined || additionalModels.length === 0) return model ?? ''
  return `${model} (+ ${additionalModels.join(', ')})`
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `   ${line}`)
    .join('\n')
}

function cell(text: string): string {
  return singleLine(text).replace(/(\\*)\|/g, '$1$1\\|')
}

function singleLine(text: string): string {
  return toTerminalText(text)
    .replace(/\s*\n\s*/g, ' ')
    .trim()
}

function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH)
}
