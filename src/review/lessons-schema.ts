import { z } from 'zod'
import { providerSchema } from './report-schema.js'

export const LessonAnswerSchema = z.object({
  rule: z.string().default(''),
  scope: z.array(z.string()).default([]),
  misses: z.array(z.number().int()),
  extends: z.number().int().nullable().default(null),
})

export const LessonsEnvelopeSchema = z.object({ lessons: z.array(z.unknown()) })

export const LESSONS_JSON_SCHEMA = providerSchema(
  z.strictObject({
    lessons: z.array(
      z.strictObject({
        rule: z.string(),
        scope: z.array(z.string()),
        misses: z.array(z.number().int()),
        extends: z.number().int().nullable(),
      }),
    ),
  }),
)
