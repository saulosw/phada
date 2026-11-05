import { LessonNotFoundError } from '../app/decide-lesson.js'
import type { AcceptLessonDeps } from '../app/decide-lesson.js'
import { dataFiles } from '../config/data-paths.js'
import type { HistoryCommandDeps } from './history-access.js'
import { existingHistory } from './history-access.js'
import { userRepoConfigTemplate } from './init-templates.js'

export type LessonHistoryDeps = Pick<
  HistoryCommandDeps,
  'env' | 'home' | 'files' | 'clock' | 'openHistoryStore'
>

export async function withLessonHistory<T>(
  lessonId: number,
  deps: LessonHistoryDeps,
  decide: (lessonDeps: AcceptLessonDeps) => Promise<T> | T,
): Promise<T> {
  const history = await existingHistory(dataFiles(deps.env, deps.home).history, deps)
  if (history === undefined) throw new LessonNotFoundError(lessonId)
  try {
    return await decide({
      history,
      files: deps.files,
      env: deps.env,
      home: deps.home,
      template: userRepoConfigTemplate,
      now: () => deps.clock().toISOString(),
    })
  } finally {
    history.close()
  }
}
