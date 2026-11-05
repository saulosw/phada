import { InvalidLessonsAnswerError } from './errors.js'
import { jsonObjects, preview } from './json-objects.js'
import { LessonAnswerSchema, LessonsEnvelopeSchema } from './lessons-schema.js'

export interface LessonAnswer {
  rule: string
  scope: string[]
  misses: number[]
  extends: number | null
}

export function parseLessons(text: string): LessonAnswer[] {
  const envelope = jsonObjects(text)
    .map((object) => LessonsEnvelopeSchema.safeParse(object))
    .find((parsed) => parsed.success)
  if (envelope === undefined || !envelope.success) {
    throw new InvalidLessonsAnswerError('no lessons list in the answer', preview(text))
  }
  return envelope.data.lessons.flatMap((item) => {
    const parsed = LessonAnswerSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}
