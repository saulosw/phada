import type { ReviewComment } from '../github/create-review.js'
import { FINDING_MARKER, reviewMarker } from '../publish/markers.js'
import type { PublicationPlan } from '../publish/types.js'
import { scoreFocus } from '../review/score.js'
import type { FileChange, Finding, ReviewResult, Severity } from '../review/types.js'
import { english } from './i18n/en.js'
import type { Messages } from './i18n/messages.js'
import { githubBlock, githubCell, githubLine } from './markdown-text.js'
import { modelLabel, shortSha } from './review-text.js'

export const GITHUB_BODY_LIMIT = 65_536

const MAX_FILE_ROWS = 300
const SEVERITIES: readonly Severity[] = ['P0', 'P1', 'P2']

export interface GitHubReview {
  body: string
  comments: ReviewComment[]
}

interface BodyParts {
  reason: string
  summary: string
  files: string
  model: string
  stillOpen: Finding[]
  stillOpenOmitted: number
  worthChecking: Finding[]
  worthCheckingOmitted: number
}

export function formatGitHubReview(
  result: ReviewResult,
  plan: PublicationPlan,
  limit = GITHUB_BODY_LIMIT,
  messages: Messages = english,
): GitHubReview {
  if (plan.comments.length === 0 && plan.stillOpen.length > 0) {
    return { body: onlyStillOpenBody(result, plan, messages), comments: [] }
  }
  return {
    body: reviewBody(result, plan, limit, messages),
    comments: plan.comments.map((finding) => ({
      path: finding.file,
      line: finding.line,
      body: commentBody(finding, limit, messages),
    })),
  }
}

export function formatGitHubPreview(
  { body, comments }: GitHubReview,
  messages: Messages = english,
): string {
  const blocks = comments.map(
    (comment, index) =>
      `${messages.github.preview(index + 1, comments.length, `${comment.path}:${comment.line}`)}\n\n${comment.body}`,
  )
  return `${[body, ...blocks].join('\n\n')}\n`
}

function onlyStillOpenBody(
  result: ReviewResult,
  plan: PublicationPlan,
  messages: Messages,
): string {
  const sha = shortSha(result.target.headSha)
  return [
    `## ${messages.github.heading}: ${messages.github.onlyStillOpenTitle}`,
    messages.github.onlyStillOpen(plan.openThreads, sha),
    `---\n<sub>${footer(result, githubLine(modelLabel(result)), messages)}</sub>`,
    reviewMarker({ sha: result.target.headSha, findings: result.findings.length }),
  ].join('\n\n')
}

function reviewBody(
  result: ReviewResult,
  plan: PublicationPlan,
  limit: number,
  messages: Messages,
): string {
  const parts: BodyParts = {
    reason: messages.scoreReason(scoreFocus(result.findings)),
    summary: result.summary,
    files: filesDetails(result.files, messages),
    model: modelLabel(result),
    stillOpen: [...plan.stillOpen],
    stillOpenOmitted: 0,
    worthChecking: [...result.worthChecking],
    worthCheckingOmitted: result.worthCheckingOmitted,
  }
  const render = () => renderBody(result, plan, parts, messages)
  if (render().length > limit && parts.files !== '') {
    parts.files = messages.github.filesTruncated(result.files.length)
  }
  fit(parts, ['summary', 'reason'], render, limit, messages)
  omitToFit(parts, 'worthChecking', 'worthCheckingOmitted', render, limit)
  omitToFit(parts, 'stillOpen', 'stillOpenOmitted', render, limit)
  fit(parts, ['model'], render, limit, messages)
  return render()
}

function renderBody(
  result: ReviewResult,
  plan: PublicationPlan,
  parts: BodyParts,
  messages: Messages,
): string {
  const { score } = result
  const summary = githubBlock(parts.summary)
  return [
    `## ${messages.github.heading}: ${score.value}/5 (${messages.scoreLabels[score.value]})`,
    capitalize(githubBlock(parts.reason)),
    summary === '' ? '' : `### ${messages.summary}\n\n${summary}`,
    parts.files,
    countsLine(plan, messages),
    findingList(messages.github.stillOpen, parts.stillOpen, parts.stillOpenOmitted, messages),
    findingList(
      messages.worthChecking(result.minConfidence),
      parts.worthChecking,
      parts.worthCheckingOmitted,
      messages,
    ),
    messages.dropped(result.dropped),
    `---\n<sub>${footer(result, githubLine(parts.model), messages)}</sub>`,
    reviewMarker({ sha: result.target.headSha, findings: result.findings.length }),
  ]
    .filter((section) => section !== '')
    .join('\n\n')
}

function filesDetails(files: readonly FileChange[], messages: Messages): string {
  if (files.length === 0) return ''
  const rows = files
    .slice(0, MAX_FILE_ROWS)
    .map(
      ({ path, change, findings }) =>
        `| ${githubCell(path)} | ${githubCell(change)} | ${findings} |`,
    )
  const hidden = files.length - MAX_FILE_ROWS
  const more = hidden > 0 ? ['', `+${messages.moreFiles(hidden)}`] : []
  return [
    `<details><summary>${messages.files} (${files.length})</summary>`,
    '',
    `| ${messages.fileColumns.join(' | ')} |`,
    '| --- | --- | --- |',
    ...rows,
    ...more,
    '',
    '</details>',
  ].join('\n')
}

function countsLine({ comments, stillOpen }: PublicationPlan, messages: Messages): string {
  const open = stillOpen.length > 0 ? ` · ${messages.github.stillOpenCount(stillOpen.length)}` : ''
  if (comments.length === 0) return ''
  const bySeverity = SEVERITIES.flatMap((severity) => {
    const count = comments.filter((finding) => finding.severity === severity).length
    return count === 0 ? [] : [`${count} ${severity}`]
  })
  return `${messages.github.inlineComments(bySeverity.join(', '), comments.length)}${open}`
}

function findingList(
  heading: string,
  findings: readonly Finding[],
  omitted: number,
  messages: Messages,
): string {
  if (findings.length === 0 && omitted === 0) return ''
  const items = findings.map(
    ({ severity, file, line, title, confidence }) =>
      `- **${severity}** · ${githubLine(file)}:${line}: ${githubLine(title)} (${messages.confidence} ${confidence})`,
  )
  if (omitted > 0) items.push(`- ${messages.moreItems(omitted)}`)
  return [`### ${heading}`, '', ...items].join('\n')
}

function footer(result: ReviewResult, model: string, messages: Messages): string {
  const provider =
    result.model === undefined ? result.providerId : `${result.providerId} (${model})`
  const parts = [messages.github.generatedWith, provider]
  if (result.verification !== undefined) parts.push(messages.verification(result.verification))
  parts.push(shortSha(result.target.headSha))
  return parts.join(' · ')
}

function commentBody(finding: Finding, limit: number, messages: Messages): string {
  const parts = { title: finding.title, why: finding.why, fix: finding.fix ?? '' }
  const render = () => {
    const fix = githubBlock(parts.fix)
    return [
      `**${finding.severity}** · ${githubLine(parts.title)} · ${messages.confidence} ${finding.confidence}`,
      githubBlock(parts.why),
      ...(fix === '' ? [] : [`**${messages.fix}:** ${fix}`]),
      FINDING_MARKER,
    ].join('\n\n')
  }
  fit(parts, ['why', 'fix', 'title'], render, limit, messages)
  return render()
}

function fit<K extends string>(
  parts: Record<K, string>,
  keys: readonly K[],
  render: () => string,
  limit: number,
  messages: Messages,
): void {
  for (const key of keys) {
    let overflow = render().length - limit
    while (overflow > 0 && parts[key] !== '') {
      const shorter = truncate(parts[key], parts[key].length - overflow, messages)
      if (shorter === parts[key]) break
      parts[key] = shorter
      overflow = render().length - limit
    }
  }
}

function truncate(text: string, maxLength: number, messages: Messages): string {
  if (text.length <= maxLength) return text
  const suffix = messages.github.truncated
  const kept = text.slice(0, Math.max(0, maxLength - suffix.length)).replace(/[\uD800-\uDBFF]$/, '')
  return `${kept}${suffix}`
}

function omitToFit(
  parts: BodyParts,
  key: 'stillOpen' | 'worthChecking',
  omittedKey: 'stillOpenOmitted' | 'worthCheckingOmitted',
  render: () => string,
  limit: number,
): void {
  while (render().length > limit && parts[key].length > 0) {
    parts[key].pop()
    parts[omittedKey] += 1
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
