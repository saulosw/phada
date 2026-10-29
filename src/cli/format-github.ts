import type { ReviewComment } from '../github/create-review.js'
import { redactSecrets } from '../providers/redact-secrets.js'
import { FINDING_MARKER, reviewMarker } from '../publish/markers.js'
import type { PublicationPlan } from '../publish/types.js'
import type { CiSummary } from '../context/types.js'
import { scoreFocus } from '../review/score.js'
import { normalize } from '../review/suggestions.js'
import type { FileChange, Finding, ReviewResult, Severity } from '../review/types.js'
import { debtItem } from './debt-text.js'
import { findingReferences, leftOutLine } from './finding-references.js'
import { english } from './i18n/en.js'
import type { Messages } from './i18n/messages.js'
import { codeFence, githubBlock, githubCell, githubLine } from './markdown-text.js'
import { firstNames } from './name-list.js'
import { shortSha } from './review-text.js'

export const GITHUB_BODY_LIMIT = 65_536

const MAX_FILE_ROWS = 300
const SEVERITIES: readonly Severity[] = ['P0', 'P1', 'P2']
const BUTTERFLY = '🦋'
const MAX_DEBT_LINES = 20

export interface GitHubReview {
  body: string
  comments: ReviewComment[]
}

interface BodyParts {
  reason: string
  summary: string
  skillBodies: string
  files: string
  stillOpen: Finding[]
  stillOpenOmitted: number
  worthChecking: Finding[]
  worthCheckingOmitted: number
  debt: Finding[]
  debtOmitted: number
}

export function formatGitHubReview(
  result: ReviewResult,
  plan: PublicationPlan,
  limit = GITHUB_BODY_LIMIT,
  messages: Messages = english,
  ci?: CiSummary,
): GitHubReview {
  const ciText = ci === undefined ? '' : ciLine(ci, messages)
  if (plan.comments.length === 0 && plan.stillOpen.length > 0) {
    return redacted({ body: onlyStillOpenBody(result, plan, messages, ciText), comments: [] })
  }
  return redacted({
    body: reviewBody(result, plan, limit, messages, ciText),
    comments: plan.comments.map((finding) => findingComment(finding, limit, messages)),
  })
}

function redacted({ body, comments }: GitHubReview): GitHubReview {
  return {
    body: redactSecrets(body),
    comments: comments.map((comment) => ({ ...comment, body: redactSecrets(comment.body) })),
  }
}

export function formatIgnoredOnlyReview(
  headSha: string,
  ignored: readonly string[],
  messages: Messages = english,
  diff?: string,
): GitHubReview {
  const sha = shortSha(headSha)
  const body = [
    `## ${BUTTERFLY} ${messages.github.allIgnoredTitle}`,
    messages.github.allIgnored(sha),
    leftOutLine(ignored, messages),
    reviewMarker({ sha: headSha, findings: 0, ...(diff === undefined ? {} : { diff }) }),
  ]
    .filter((section) => section !== '')
    .join('\n\n')
  return { body, comments: [] }
}

export function formatResolvedReply(
  headSha: string,
  reason: string,
  messages: Messages = english,
): string {
  return redactSecrets(messages.github.resolvedReply(shortSha(headSha), githubBlock(reason)))
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
  ci: string,
): string {
  const sha = shortSha(result.target.headSha)
  return [
    `## ${BUTTERFLY} ${messages.github.onlyStillOpenTitle}`,
    ci,
    messages.github.onlyStillOpen(plan.openThreads, sha),
    fixedLine(result, plan, messages),
    debtList(...listedDebt(result), messages),
    markerOf(result),
  ]
    .filter((section) => section !== '')
    .join('\n\n')
}

function reviewBody(
  result: ReviewResult,
  plan: PublicationPlan,
  limit: number,
  messages: Messages,
  ci: string,
): string {
  const parts: BodyParts = {
    reason: messages.scoreReason(scoreFocus(result.findings)),
    summary: result.summary,
    skillBodies: (result.skillBodies ?? [])
      .map(
        ({ skill, text }) =>
          `**${messages.github.skillBody(githubLine(skill))}**\n\n${githubBlock(text)}`,
      )
      .join('\n\n'),
    files: filesDetails(result.files, messages),
    stillOpen: [...plan.stillOpen],
    stillOpenOmitted: 0,
    worthChecking: [...result.worthChecking],
    worthCheckingOmitted: result.worthCheckingOmitted,
    ...debtParts(result),
  }
  const render = () => renderBody(result, plan, parts, messages, ci)
  if (render().length > limit && parts.files !== '') {
    parts.files = messages.github.filesTruncated(result.files.length)
  }
  fit(parts, ['skillBodies', 'summary', 'reason'], render, limit, messages)
  omitToFit(parts, 'debt', 'debtOmitted', render, limit)
  omitToFit(parts, 'worthChecking', 'worthCheckingOmitted', render, limit)
  omitToFit(parts, 'stillOpen', 'stillOpenOmitted', render, limit)
  return render()
}

function renderBody(
  result: ReviewResult,
  plan: PublicationPlan,
  parts: BodyParts,
  messages: Messages,
  ci: string,
): string {
  const { score } = result
  const summary = githubBlock(parts.summary)
  return [
    `## ${BUTTERFLY} ${score.value}/5 (${messages.scoreLabels[score.value]})`,
    ci,
    capitalize(githubBlock(parts.reason)),
    summary === '' ? '' : `### ${messages.summary}\n\n${summary}`,
    parts.skillBodies,
    parts.files,
    countsLine(plan, messages),
    fixedLine(result, plan, messages),
    findingList(messages.github.stillOpen, parts.stillOpen, parts.stillOpenOmitted, messages),
    findingList(
      messages.worthChecking(result.minConfidence),
      parts.worthChecking,
      parts.worthCheckingOmitted,
      messages,
    ),
    debtList(parts.debt, parts.debtOmitted, messages),
    messages.dropped(result.dropped),
    leftOutLine(result.ignored ?? [], messages),
    markerOf(result),
  ]
    .filter((section) => section !== '')
    .join('\n\n')
}

function ciLine({ state, total, failing, pending }: CiSummary, messages: Messages): string {
  if (state === 'none') return ''
  const names = (list: readonly string[]) => ({
    count: list.length,
    shown: firstNames(list, githubLine),
  })
  return messages.github.ci(state, total, names(failing), names(pending))
}

function fixedLine(result: ReviewResult, plan: PublicationPlan, messages: Messages): string {
  if (plan.fixedThreads === 0) return ''
  return messages.github.fixedThreads(plan.fixedThreads, shortSha(result.target.headSha))
}

function markerOf({ target, findings }: ReviewResult): string {
  const { headSha: sha, diffFingerprint: diff } = target
  return reviewMarker({ sha, findings: findings.length, ...(diff === undefined ? {} : { diff }) })
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

function debtList(debt: readonly Finding[], omitted: number, messages: Messages): string {
  if (debt.length === 0 && omitted === 0) return ''
  const items = debt.map((finding) => debtItem(finding, githubLine))
  if (omitted > 0) items.push(`- ${messages.moreItems(omitted)}`)
  return [`### ${messages.debt}`, '', messages.debtNote, '', ...items].join('\n')
}

function listedDebt({ debt = [] }: ReviewResult): [Finding[], number] {
  return [debt.slice(0, MAX_DEBT_LINES), Math.max(debt.length - MAX_DEBT_LINES, 0)]
}

function debtParts(result: ReviewResult): Pick<BodyParts, 'debt' | 'debtOmitted'> {
  const [debt, debtOmitted] = listedDebt(result)
  return { debt, debtOmitted }
}

function findingComment(finding: Finding, limit: number, messages: Messages): ReviewComment {
  const { suggestion } = finding
  if (suggestion !== undefined) {
    const fence = codeFence(suggestion.replacement)
    const code = normalize(suggestion.replacement)
    const block =
      code === '' ? `${fence}suggestion\n${fence}` : `${fence}suggestion\n${code}\n${fence}`
    const body = commentBody(finding, limit, messages, block)
    if (body.length <= limit) {
      return {
        path: finding.file,
        ...(suggestion.startLine === suggestion.endLine ? {} : { startLine: suggestion.startLine }),
        line: suggestion.endLine,
        body,
      }
    }
  }
  return { path: finding.file, line: finding.line, body: commentBody(finding, limit, messages) }
}

function commentBody(finding: Finding, limit: number, messages: Messages, suggestion = ''): string {
  const parts = { title: finding.title, why: finding.why, fix: finding.fix ?? '' }
  const references = findingReferences(finding, messages, { withLocalFiles: false })
  const render = () => {
    const fix = githubBlock(parts.fix)
    return [
      `**${finding.severity}** · ${githubLine(parts.title)} · ${messages.confidence} ${finding.confidence}`,
      githubBlock(parts.why),
      ...(fix === '' ? [] : [`**${messages.fix}:** ${fix}`]),
      ...(suggestion === '' ? [] : [suggestion]),
      ...(references === '' ? [] : [`<sub>${references}</sub>`]),
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
  key: 'stillOpen' | 'worthChecking' | 'debt',
  omittedKey: 'stillOpenOmitted' | 'worthCheckingOmitted' | 'debtOmitted',
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
