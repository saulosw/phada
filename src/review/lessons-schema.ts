import { z } from 'zod'
import { providerSchema } from './report-schema.js'

const LESSON_KINDS = ['check', 'avoid'] as const

export const LessonAnswerSchema = z.object({
  kind: z.enum(LESSON_KINDS).default('check'),
  rule: z.string().default(''),
  scope: z.array(z.string()).default([]),
  misses: z.array(z.number().int()).default([]),
  findings: z.array(z.number().int()).default([]),
  extends: z.number().int().nullable().default(null),
})

export const LessonsEnvelopeSchema = z.object({ lessons: z.array(z.unknown()) })

export const LESSONS_JSON_SCHEMA = providerSchema(
  z.strictObject({
    lessons: z.array(
      z.strictObject({
        kind: z.enum(LESSON_KINDS),
        rule: z.string(),
        scope: z.array(z.string()),
        misses: z.array(z.number().int()),
        findings: z.array(z.number().int()),
        extends: z.number().int().nullable(),
      }),
    ),
  }),
)
