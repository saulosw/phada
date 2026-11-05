import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { fromRow, insertStatement, LESSON_TABLE, MISS_TABLE } from './history-columns.js'
import { transaction } from './history-feedback.js'
import type { MissRecord } from './history-misses.js'

export type LessonState = 'pending' | 'accepted' | 'discarded'

export interface NewLesson {
  rule: string
  scope: readonly string[]
  missIds: readonly number[]
}

export interface LessonLink {
  lessonId: number
  missIds: readonly number[]
}

export interface LessonChanges {
  repo: string
  provider?: string
  model?: string
  created: readonly NewLesson[]
  attached: readonly LessonLink[]
}

export interface LessonRecord {
  id: number
  repo: string
  rule: string
  scope: string[]
  state: LessonState
  provider?: string
  model?: string
  createdAt: string
  decidedAt?: string
  misses: MissRecord[]
}

export interface LessonFilter {
  repo?: string
  states?: readonly LessonState[]
}

export function recordLessons(
  db: DatabaseSync,
  changes: LessonChanges,
  createdAt: string,
): number[] {
  const link = db.prepare(
    'insert into lesson_miss (lesson_id, miss_id) values (?, ?) on conflict do nothing',
  )
  const linkAll = (lessonId: number, missIds: readonly number[]) => {
    for (const missId of missIds) link.run(lessonId, missId)
  }
  return transaction(db, () => {
    const ids = changes.created.map(({ rule, scope, missIds }) => {
      const { sql, values } = insertStatement(LESSON_TABLE, {
        repo: changes.repo,
        rule,
        scope,
        state: 'pending',
        provider: changes.provider,
        model: changes.model,
        createdAt,
      })
      const id = Number(db.prepare(sql).run(...values).lastInsertRowid)
      linkAll(id, missIds)
      return id
    })
    for (const { lessonId, missIds } of changes.attached) linkAll(lessonId, missIds)
    return ids
  })
}

export function lessons(db: DatabaseSync, filter: LessonFilter): LessonRecord[] {
  const where: string[] = []
  const values: SQLInputValue[] = []
  if (filter.repo !== undefined) {
    where.push('repo = ?')
    values.push(filter.repo.toLowerCase())
  }
  if (filter.states !== undefined) {
    if (filter.states.length === 0) return []
    where.push(`state in (${filter.states.map(() => '?').join(', ')})`)
    values.push(...filter.states)
  }
  const clause = where.length === 0 ? '' : ` where ${where.join(' and ')}`
  const rows = db.prepare(`select * from lesson${clause} order by id`).all(...values)
  const found = rows.map((row) => fromRow<Omit<LessonRecord, 'misses'>>(row, LESSON_TABLE))
  const missesOf = lessonMisses(
    db,
    found.map(({ id }) => id),
  )
  return found.map((lesson) => ({ ...lesson, misses: missesOf.get(lesson.id) ?? [] }))
}

export function linkedMissIds(db: DatabaseSync): Set<number> {
  return new Set(
    db
      .prepare('select distinct miss_id from lesson_miss')
      .all()
      .map((row) => Number(row.miss_id)),
  )
}

function lessonMisses(db: DatabaseSync, lessonIds: readonly number[]): Map<number, MissRecord[]> {
  const byLesson = new Map<number, MissRecord[]>()
  if (lessonIds.length === 0) return byLesson
  const rows = db
    .prepare(
      `select lesson_miss.lesson_id as lesson_id, miss.* from lesson_miss
       join miss on miss.id = lesson_miss.miss_id
       where lesson_miss.lesson_id in (${lessonIds.map(() => '?').join(', ')})
       order by miss.id`,
    )
    .all(...lessonIds)
  for (const row of rows) {
    const lessonId = Number(row.lesson_id)
    byLesson.set(lessonId, [
      ...(byLesson.get(lessonId) ?? []),
      fromRow<MissRecord>(row, MISS_TABLE),
    ])
  }
  return byLesson
}
