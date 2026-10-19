import { z } from 'zod'
import { providerSchema } from './report-schema.js'

const RECHECK_VERDICT_SHAPE = {
  id: z.number().int().positive(),
  verdict: z.enum(['fixed', 'still-valid', 'unsure']),
  reason: z.string().min(1),
}

export const RecheckVerdictSchema = z.object(RECHECK_VERDICT_SHAPE)

export const RecheckEnvelopeSchema = z.object({ verdicts: z.array(z.unknown()) })

export const RECHECK_JSON_SCHEMA = providerSchema(
  z.strictObject({ verdicts: z.array(z.strictObject(RECHECK_VERDICT_SHAPE)) }),
)
