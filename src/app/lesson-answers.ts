import { posix } from 'node:path'
import { matcher } from '../context/ignore.js'
import type { LessonAnswer } from '../review/parse-lessons.js'
import type { LessonChanges } from '../store/history-store.js'

const MAX_RULE_CHARS = 1000
const MAX_GLOBS = 10

export interface LessonFile {
  id: number
  file: string
}

export function checkLessonAnswers(
  answers: readonly LessonAnswer[],
  sent: readonly LessonFile[],
  pendingIds: ReadonlySet<number>,
): Pick<LessonChanges, 'created' | 'attached'> {
  const fileOf = new Map(sent.map(({ id, file }) => [id, file]))
  const created: LessonChanges['created'][number][] = []
  const attached = new Map<number, number[]>()
  for (const answer of answers) {
    const missIds = [...new Set(answer.misses)].filter((id) => fileOf.has(id))
    if (missIds.length === 0) continue
    if (answer.extends !== null && pendingIds.has(answer.extends)) {
      const known = attached.get(answer.extends) ?? []
      attached.set(answer.extends, [...new Set([...known, ...missIds])])
      continue
    }
    const rule = answer.rule.trim()
    const globs = answer.scope.map((glob) => glob.trim()).filter((glob) => glob !== '')
    if (rule === '' || rule.length > MAX_RULE_CHARS || globs.length === 0) continue
    const files = [...new Set(missIds.map((id) => fileOf.get(id) ?? ''))]
    created.push({ rule, scope: scopeOf(globs.slice(0, MAX_GLOBS), files), missIds })
  }
  return {
    created,
    attached: [...attached].map(([lessonId, missIds]) => ({ lessonId, missIds })),
  }
}

function scopeOf(globs: readonly string[], files: readonly string[]): string[] {
  const matching = globs.filter((glob) => files.some((file) => matches(glob, file)))
  const scope: string[] = []
  for (const glob of globs) {
    if (matching.includes(glob)) {
      scope.push(glob)
      continue
    }
    const covered = [...matching, ...scope]
    const uncovered = files.find((file) => !covered.some((known) => matches(known, file)))
    scope.push(folderGlob(uncovered ?? files[0] ?? ''))
  }
  return [...new Set(scope)]
}

function matches(glob: string, file: string): boolean {
  try {
    return matcher([glob])(file)
  } catch {
    return false
  }
}

function folderGlob(file: string): string {
  const folder = posix.dirname(file)
  return folder === '.' ? file : `${folder}/**`
}
