import type { HistoryStore, LessonRecord } from '../store/history-store.js'

export type LessonReader = Pick<HistoryStore, 'lessons'>

export interface LessonList {
  lessons: LessonRecord[]
  hidden: number
}

export function readLessons(
  history: LessonReader | undefined,
  filter: { repo?: string },
  all: boolean,
): LessonList {
  if (history === undefined) return { lessons: [], hidden: 0 }
  const lessons = history.lessons(all ? filter : { ...filter, states: ['pending'] })
  const hidden = all ? 0 : history.lessons({ ...filter, states: ['accepted', 'discarded'] }).length
  return { lessons: lessons.sort(byWeight), hidden }
}

function byWeight(a: LessonRecord, b: LessonRecord): number {
  return b.misses.length - a.misses.length || b.createdAt.localeCompare(a.createdAt) || b.id - a.id
}
