import { z } from 'zod'
import { ConfidenceSchema, providerSchema, SeveritySchema } from './report-schema.js'

const VERDICT_SHAPE = {
  id: z.number().int().positive(),
  verdict: z.enum(['confirmed', 'rejected']),
  severity: SeveritySchema,
  confidence: ConfidenceSchema,
  reason: z.string().min(1),
}

export const VerdictSchema = z.object(VERDICT_SHAPE)

export type Verdict = z.infer<typeof VerdictSchema>

export const VerificationEnvelopeSchema = z.object({ verdicts: z.array(z.unknown()) })

export const VERIFICATION_JSON_SCHEMA = providerSchema(
  z.strictObject({ verdicts: z.array(z.strictObject(VERDICT_SHAPE)) }),
)
