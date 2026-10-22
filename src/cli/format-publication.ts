import type { SkipReason } from '../publish/types.js'
import type { RecheckReport } from '../review/types.js'
import { shortSha } from './review-text.js'
import { formatCount } from './units.js'

export function formatSkipMessage(headSha: string, reason: SkipReason): string {
  if (reason.kind === 'closed-or-draft') {
    return `The pull request is closed or a draft now: skipping ${shortSha(headSha)}.`
  }
  if (reason.kind === 'same-diff') {
    return `${shortSha(headSha)}: the reviewed diff did not change since ${shortSha(reason.since)}, which Phada reviewed (files left out of the review do not count). Use --force to review again.`
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

export function formatRecheckMessage({
  threads,
  fixed,
  stillValid,
  unsure,
}: RecheckReport): string {
  return `Rechecked ${formatCount(threads, 'comment')} from previous reviews: ${fixed} fixed, ${stillValid} still valid, ${unsure} unsure.`
}

export function formatResolvedMessage(resolved: number, total: number): string {
  return `Resolved ${resolved} of ${formatCount(total, 'comment')} found fixed.`
}

export function formatWouldResolveMessage(count: number): string {
  return `Without --dry-run: ${formatCount(count, 'fixed comment')} would be resolved.`
}
