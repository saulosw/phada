import type { SkipReason } from '../publish/types.js'
import { shortSha } from './review-text.js'
import { formatCount } from './units.js'

export function formatSkipMessage(headSha: string, reason: SkipReason): string {
  if (reason.kind === 'closed-or-draft') {
    return `The pull request is closed or a draft now: skipping ${shortSha(headSha)}.`
  }
  if (reason.kind === 'same-diff') {
    const what = reason.ignoredOnly
      ? 'only files left out of the review changed'
      : 'the diff did not change'
    return `${shortSha(headSha)}: ${what} since ${shortSha(reason.since)}, which Phada reviewed. Use --force to review again.`
  }
  if (reason.kind === 'already-reviewed') {
    return `${shortSha(headSha)} already reviewed by Phada: skipping.`
  }
  const state =
    reason.kind === 'open-threads'
      ? `${formatCount(reason.openThreads, 'thread')} still open`
      : 'nothing was found'
  return `${shortSha(headSha)} already reviewed by Phada; ${state}. Use --force to review again.`
}

export function formatPublishedMessage(
  url: string,
  comments: number,
  stillOpen: number,
  dismissed = 0,
): string {
  const what = comments === 0 ? '' : ` with ${formatCount(comments, 'inline comment')}`
  const notes = [
    stillOpen === 0 ? '' : `${formatCount(stillOpen, 'finding')} still open from previous reviews`,
    dismissed === 0
      ? ''
      : `${formatCount(dismissed, 'finding')} dismissed earlier, not posted again`,
  ].filter((note) => note !== '')
  return `Published the review${what}: ${url}${notes.length === 0 ? '' : ` (${notes.join('; ')})`}`
}
