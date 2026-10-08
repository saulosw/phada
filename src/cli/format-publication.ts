import type { SkipReason } from '../publish/types.js'
import { shortSha } from './review-text.js'
import { formatCount } from './units.js'

export function formatSkipMessage(headSha: string, reason: SkipReason): string {
  const state =
    reason.kind === 'open-threads'
      ? `${formatCount(reason.openThreads, 'thread')} still open`
      : 'nothing was found'
  return `${shortSha(headSha)} already reviewed by Phada; ${state}. Use --force to review again.`
}

export function formatPublishedMessage(url: string, comments: number, stillOpen: number): string {
  const what = comments === 0 ? '' : ` with ${formatCount(comments, 'inline comment')}`
  const open =
    stillOpen === 0
      ? ''
      : ` (${formatCount(stillOpen, 'finding')} still open from previous reviews)`
  return `Published the review${what}: ${url}${open}`
}
