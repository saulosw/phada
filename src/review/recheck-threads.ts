import type { Toolbox } from '../investigation/toolbox.js'
import type { ReviewProvider } from '../providers/types.js'
import { InvalidReviewReportError } from './errors.js'
import { jsonObjects, preview } from './json-objects.js'
import { newNonce } from './nonce.js'
import { buildRecheckPrompt } from './recheck-prompt.js'
import { RecheckEnvelopeSchema, RecheckVerdictSchema } from './recheck-schema.js'
import type { RecheckReport, RecheckThread, RecheckVerdict, ReviewRequest } from './types.js'

const UNCHANGED_REASON = 'The file did not change.'
const NO_VERDICT_REASON = 'No verdict for this comment.'
const NO_ACCESS_REASON = 'No patch and no repository access to check it.'

export async function recheckThreads(
  request: ReviewRequest,
  threads: readonly RecheckThread[],
  provider: ReviewProvider,
  nonce: string = newNonce(),
  tools?: Toolbox,
): Promise<RecheckReport> {
  const blind = (thread: RecheckThread) => thread.patch === undefined && tools === undefined
  const changed = threads.filter((thread) => thread.changed && !blind(thread))
  const output =
    changed.length === 0
      ? undefined
      : await provider.review(buildRecheckPrompt(request, changed, nonce, tools))
  const answers = output === undefined ? new Map() : parseRecheck(output.text)
  const verdicts = threads.map((thread): RecheckVerdict => {
    const { id: threadId, file, line, title } = thread
    if (thread.changed && blind(thread)) {
      return {
        threadId,
        file,
        line,
        title,
        verdict: 'unsure',
        reason: NO_ACCESS_REASON,
        by: 'no-access',
      }
    }
    if (!thread.changed) {
      return {
        threadId,
        file,
        line,
        title,
        verdict: 'still-valid',
        reason: UNCHANGED_REASON,
        by: 'unchanged',
      }
    }
    const answer = answers.get(changed.indexOf(thread) + 1)
    return {
      threadId,
      file,
      line,
      title,
      verdict: answer?.verdict ?? 'unsure',
      reason: answer?.reason ?? NO_VERDICT_REASON,
      by: 'ai',
    }
  })
  const count = (kind: RecheckVerdict['verdict']) =>
    verdicts.filter((verdict) => verdict.verdict === kind).length
  return {
    threads: threads.length,
    fixed: count('fixed'),
    stillValid: count('still-valid'),
    unsure: count('unsure'),
    verdicts,
    durationMs: output?.durationMs ?? 0,
    ...(output?.usage === undefined ? {} : { usage: output.usage }),
  }
}

function parseRecheck(
  text: string,
): Map<number, { verdict: RecheckVerdict['verdict']; reason: string }> {
  const envelope = jsonObjects(text)
    .map((object) => RecheckEnvelopeSchema.safeParse(object))
    .find((parsed) => parsed.success)
  if (envelope === undefined || !envelope.success) {
    throw new InvalidReviewReportError('no verdicts in the recheck', preview(text))
  }
  const answers = new Map<number, { verdict: RecheckVerdict['verdict']; reason: string }>()
  for (const item of envelope.data.verdicts) {
    const parsed = RecheckVerdictSchema.safeParse(item)
    if (parsed.success && !answers.has(parsed.data.id)) {
      answers.set(parsed.data.id, { verdict: parsed.data.verdict, reason: parsed.data.reason })
    }
  }
  return answers
}
