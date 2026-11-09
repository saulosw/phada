import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import {
  FINDING_TABLE,
  fromRow,
  insertStatement,
  LESSON_TABLE,
  MISS_TABLE,
  updateStatement,
} from './history-columns.js'
import type { HistoryTable } from './history-columns.js'
import { transaction } from './history-feedback.js'
import type { FindingRow } from './history-feedback.js'
import type { MissRecord } from './history-misses.js'

export type LessonState = 'pending' | 'accepted' | 'discarded'

export type LessonKind = 'check' | 'avoid'

export interface NewLesson {
  kind?: LessonKind
  rule: string
  scope: readonly string[]
  missIds: readonly number[]
  findingIds?: readonly number[]
}

export interface LessonLink {
  lessonId: number
  missIds: readonly number[]
  findingIds?: readonly number[]
}

export interface LessonChanges {
  repo: string
  provider?: string
  model?: string
  created: readonly NewLesson[]
  attached: readonly LessonLink[]
  sent?: readonly number[]
  sentFindings?: readonly number[]
}

export interface LessonRecord {
  id: number
  repo: string
  kind: LessonKind
  rule: string
  scope: string[]
  state: LessonState
  provider?: string
  model?: string
  createdAt: string
  decidedAt?: string
  misses: MissRecord[]
  findings: FindingRow[]
}

export type LessonDecision = Exclude<LessonState, 'pending'>

export type LessonEdit = Pick<NewLesson, 'rule' | 'scope'>

export interface LessonFilter {
  id?: number
  repo?: string
  states?: readonly LessonState[]
}

export function recordLessons(
  db: DatabaseSync,
  changes: LessonChanges,
  createdAt: string,
): number[] {
  const linkMiss = db.prepare(
    'insert into lesson_miss (lesson_id, miss_id) values (?, ?) on conflict do nothing',
  )
  const linkFinding = db.prepare(
    'insert into lesson_finding (lesson_id, finding_id) values (?, ?) on conflict do nothing',
  )
  const linkAll = (lessonId: number, { missIds, findingIds = [] }: LessonSources) => {
    for (const missId of missIds) linkMiss.run(lessonId, missId)
    for (const findingId of findingIds) linkFinding.run(lessonId, findingId)
  }
  return transaction(db, () => {
    const ids = changes.created.map(({ kind, rule, scope, ...sources }) => {
      const { sql, values } = insertStatement(LESSON_TABLE, {
        repo: changes.repo,
        kind,
        rule,
        scope,
        state: 'pending',
        provider: changes.provider,
        model: changes.model,
        createdAt,
      })
      const id = Number(db.prepare(sql).run(...values).lastInsertRowid)
      linkAll(id, sources)
      return id
    })
    for (const { lessonId, ...sources } of changes.attached) linkAll(lessonId, sources)
    const markMiss = db.prepare('update miss set lessons_sent_at = ? where id = ?')
    for (const missId of changes.sent ?? []) markMiss.run(createdAt, missId)
    const markFinding = db.prepare('update finding set lessons_sent_at = ? where id = ?')
    for (const findingId of changes.sentFindings ?? []) markFinding.run(createdAt, findingId)
    return ids
  })
}

export function lessons(db: DatabaseSync, filter: LessonFilter): LessonRecord[] {
  const where: string[] = []
  const values: SQLInputValue[] = []
  if (filter.id !== undefined) {
    where.push('id = ?')
    values.push(filter.id)
  }
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
  const found = rows.map((row) =>
    fromRow<Omit<LessonRecord, 'misses' | 'findings'>>(row, LESSON_TABLE),
  )
  const ids = found.map(({ id }) => id)
  const missesOf = linkedRows<MissRecord>(db, ids, MISS_LINK)
  const findingsOf = linkedRows<FindingRow>(db, ids, FINDING_LINK)
  return found.map((lesson) => ({
    ...lesson,
    misses: missesOf.get(lesson.id) ?? [],
    findings: findingsOf.get(lesson.id) ?? [],
  }))
}

export function decideLesson(
  db: DatabaseSync,
  id: number,
  decision: LessonDecision,
  decidedAt: string,
  edit?: LessonEdit,
): boolean {
  const changes = edit === undefined ? {} : { rule: edit.rule, scope: edit.scope }
  const update = updateStatement(LESSON_TABLE, id, { state: decision, decidedAt, ...changes })
  if (update === undefined) return false
  const changed = db.prepare(`${update.sql} and state = 'pending'`).run(...update.values).changes
  return Number(changed) > 0
}

export function linkedMissIds(db: DatabaseSync): Set<number> {
  return linkedIds(db, MISS_LINK)
}

export function linkedFindingIds(db: DatabaseSync): Set<number> {
  return linkedIds(db, FINDING_LINK)
}

interface LessonSources {
  missIds: readonly number[]
  findingIds?: readonly number[]
}

interface Link {
  table: string
  column: string
  target: HistoryTable
}

const MISS_LINK: Link = { table: 'lesson_miss', column: 'miss_id', target: MISS_TABLE }
const FINDING_LINK: Link = { table: 'lesson_finding', column: 'finding_id', target: FINDING_TABLE }

function linkedIds(db: DatabaseSync, { table, column }: Link): Set<number> {
  return new Set(
    db
      .prepare(`select distinct ${column} from ${table}`)
      .all()
      .map((row) => Number(row[column])),
  )
}

function linkedRows<T>(
  db: DatabaseSync,
  lessonIds: readonly number[],
  { table, column, target }: Link,
): Map<number, T[]> {
  const byLesson = new Map<number, T[]>()
  if (lessonIds.length === 0) return byLesson
  const rows = db
    .prepare(
      `select ${table}.lesson_id as lesson_id, ${target.name}.* from ${table}
       join ${target.name} on ${target.name}.id = ${table}.${column}
       where ${table}.lesson_id in (${lessonIds.map(() => '?').join(', ')})
       order by ${target.name}.id`,
    )
    .all(...lessonIds)
  for (const row of rows) {
    const lessonId = Number(row.lesson_id)
    byLesson.set(lessonId, [...(byLesson.get(lessonId) ?? []), fromRow<T>(row, target)])
  }
  return byLesson
}
