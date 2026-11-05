import type { LessonRecord } from '../store/history-store.js'

export function lessonRuleId(lessonId: number): string {
  return `lesson-${lessonId}`
}

export function lessonThreads(lesson: Pick<LessonRecord, 'misses'>): string[] {
  const urls = lesson.misses.flatMap(({ threadUrl }) =>
    threadUrl === undefined || threadUrl === '' ? [] : [threadUrl],
  )
  return [...new Set(urls)]
}
