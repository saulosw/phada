import { InvalidReviewReportError } from './errors.js'
import { jsonObjects, preview } from './json-objects.js'
import { VerdictSchema, VerificationEnvelopeSchema } from './verification-schema.js'
import type { Verdict } from './verification-schema.js'

export function parseVerification(text: string): Verdict[] {
  const envelope = jsonObjects(text)
    .map((object) => VerificationEnvelopeSchema.safeParse(object))
    .find((parsed) => parsed.success)
  if (envelope === undefined || !envelope.success) {
    throw new InvalidReviewReportError('no verdicts in the verification', preview(text))
  }
  return envelope.data.verdicts.flatMap((item) => {
    const parsed = VerdictSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}
