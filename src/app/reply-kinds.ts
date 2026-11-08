import { REPLY_KINDS } from '../publish/types.js'
import type { ReplyKind } from '../review/types.js'

export type ReplyCounts = Record<ReplyKind, number>

export function noReplies(): ReplyCounts {
  return { ack: 0, applied: 0, question: 0, disagreed: 0, refuted: 0 }
}

export function repliedKinds(counts: ReplyCounts): { kind: ReplyKind; count: number }[] {
  return REPLY_KINDS.flatMap((kind) => (counts[kind] === 0 ? [] : [{ kind, count: counts[kind] }]))
}
