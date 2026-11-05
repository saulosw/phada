import { parse, stringify } from 'yaml'
import { firstLine, issueText } from './parse-config.js'
import { EditedLessonSchema } from './schema.js'

export interface LessonText {
  rule: string
  scope: string[]
}

export interface LessonDraft extends LessonText {
  id: number
  repo: string
  from: readonly string[]
}

export type ReadLessonDraft =
  { kind: 'empty' } | { kind: 'edited'; lesson: LessonText } | { kind: 'invalid'; message: string }

export function lessonDraftText(draft: LessonDraft): string {
  const header = [
    `# Lesson ${draft.id} for ${draft.repo}, accepted as the rule lesson-${draft.id}.`,
    '# Edit rule and scope; Phada sets id and from. Saving an empty file cancels the accept.',
    ...(draft.from.length === 0 ? [] : ['# From:', ...draft.from.map((url) => `# ${url}`)]),
  ]
  return `${header.join('\n')}\n${stringify({ rule: draft.rule, scope: draft.scope })}`
}

export function readLessonDraft(text: string): ReadLessonDraft {
  let data: unknown
  try {
    data = parse(text)
  } catch (error) {
    return {
      kind: 'invalid',
      message: firstLine(error instanceof Error ? error.message : String(error)),
    }
  }
  if (data === null || data === undefined) return { kind: 'empty' }
  const parsed = EditedLessonSchema.safeParse(data)
  if (!parsed.success) return { kind: 'invalid', message: issueText(parsed.error.issues[0]) }
  return { kind: 'edited', lesson: parsed.data }
}
