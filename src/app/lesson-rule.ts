import type { LessonRecord } from '../store/history-store.js'

export function lessonRuleId(lessonId: number): string {
  return `lesson-${lessonId}`
}

export function lessonThreads(
  lesson: Pick<LessonRecord, 'kind' | 'misses' | 'findings'>,
): string[] {
  const sources = lesson.kind === 'avoid' ? lesson.findings : lesson.misses
  const urls = sources.flatMap(({ threadUrl }) =>
    threadUrl === undefined || threadUrl === '' ? [] : [threadUrl],
  )
  return [...new Set(urls)]
}
