import type { Toolbox } from '../investigation/toolbox.js'
import type { ReviewProvider } from '../providers/types.js'
import { InvalidReviewReportError } from './errors.js'
import { jsonObjects, preview } from './json-objects.js'
import { newNonce } from './nonce.js'
import { buildReplyPrompt } from './reply-prompt.js'
import { KINDS_WITH_TEXT, ReplySchema } from './reply-schema.js'
import type { ReplyAnswer, ReplyKind, ReplyRequest, ReplyThread } from './types.js'

export async function replyToThread(
  request: ReplyRequest,
  thread: ReplyThread,
  provider: ReviewProvider,
  nonce: string = newNonce(),
  tools?: Toolbox,
): Promise<ReplyAnswer> {
  const output = await provider.review(buildReplyPrompt(request, thread, nonce, tools))
  const { kind, text } = parseReply(output.text)
  return {
    kind,
    ...(text === undefined ? {} : { text }),
    durationMs: output.durationMs,
    ...(output.usage === undefined ? {} : { usage: output.usage }),
  }
}

function parseReply(output: string): { kind: ReplyKind; text?: string } {
  const parsed = jsonObjects(output)
    .map((object) => ReplySchema.safeParse(object))
    .find((result) => result.success)
  if (parsed === undefined || !parsed.success) {
    throw new InvalidReviewReportError('no reply kind', preview(output))
  }
  const { kind, reply } = parsed.data
  if (!KINDS_WITH_TEXT.has(kind)) return { kind }
  const text = reply?.trim() ?? ''
  if (text === '') throw new InvalidReviewReportError(`no reply text for ${kind}`, preview(output))
  return { kind, text }
}
