import type { DatabaseSync } from 'node:sqlite'
import { fromRow, HARVEST_TABLE, upsertStatement } from './history-columns.js'

export interface LessonHarvest {
  repo: string
  closedSince: string
  harvestedAt: string
}

export function lessonHarvest(db: DatabaseSync, repo: string): LessonHarvest | undefined {
  const row = db.prepare('select * from lesson_harvest where repo = ?').get(repo.toLowerCase())
  return row === undefined ? undefined : fromRow<LessonHarvest>(row, HARVEST_TABLE)
}

export function saveLessonHarvest(db: DatabaseSync, harvest: LessonHarvest): void {
  const { sql, values } = upsertStatement(HARVEST_TABLE, harvest)
  db.prepare(sql).run(...values)
}

export function runRepos(db: DatabaseSync): string[] {
  return db
    .prepare('select distinct repo from run order by repo')
    .all()
    .map((row) => String(row.repo))
}
