import type { PullRequest } from '../github/pull-request.js'
import type { ReviewResult } from '../review/types.js'
import { toTerminalText } from './terminal-text.js'
import { formatBytes, formatCount, formatDuration, formatTokens } from './units.js'

const SHORT_SHA_LENGTH = 7

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
  return [
    `# Review of ${pr.repo}#${pr.number}: ${singleLine(pr.title)}`,
    `${pr.url} · head ${shortSha(result.target.headSha)} · ${state}`,
    '',
    toTerminalText(result.text).trim(),
    '',
    '---',
    footer(result),
    '',
  ].join('\n')
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

function singleLine(text: string): string {
  return toTerminalText(text)
    .replace(/\s*\n\s*/g, ' ')
    .trim()
}

function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH)
}
