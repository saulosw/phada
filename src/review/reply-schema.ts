import { z } from 'zod'
import { providerSchema } from './report-schema.js'
import type { ReplyKind } from './types.js'

const REPLY_KINDS = [
  'ack',
  'applied',
  'question',
  'disagreed',
  'refuted',
] as const satisfies readonly ReplyKind[]

export const KINDS_WITH_TEXT: ReadonlySet<ReplyKind> = new Set(['question', 'disagreed', 'refuted'])

const ReplyKindSchema = z.enum(REPLY_KINDS)

export const ReplySchema = z.object({
  kind: ReplyKindSchema,
  reply: z.string().optional(),
})

export const REPLY_JSON_SCHEMA = providerSchema(
  z.strictObject({ kind: ReplyKindSchema, reply: z.string() }),
)
