import { posix } from 'node:path'
import { matcher } from '../context/ignore.js'
import type { LessonAnswer } from '../review/parse-lessons.js'
import type { LessonKind } from '../review/lessons-prompt.js'
import type { LessonChanges, LessonLink, NewLesson } from '../store/history-store.js'

const MAX_RULE_CHARS = 1000
const MAX_GLOBS = 10

export interface LessonFile {
  id: number
  file: string
}

export interface SentToLessons {
  misses: readonly LessonFile[]
  findings: readonly LessonFile[]
  pending: readonly { id: number; kind: LessonKind }[]
}

export function checkLessonAnswers(
  answers: readonly LessonAnswer[],
  sent: SentToLessons,
): Pick<LessonChanges, 'created' | 'attached'> {
  const fileOf = {
    check: new Map(sent.misses.map(({ id, file }) => [id, file])),
    avoid: new Map(sent.findings.map(({ id, file }) => [id, file])),
  }
  const pendingKind = new Map(sent.pending.map(({ id, kind }) => [id, kind]))
  const created: NewLesson[] = []
  const attached = new Map<number, Required<LessonLink>>()
  for (const answer of answers) {
    const files = fileOf[answer.kind]
    const ids = [...new Set(answer.kind === 'check' ? answer.misses : answer.findings)].filter(
      (id) => files.has(id),
    )
    if (ids.length === 0) continue
    const sources = {
      missIds: answer.kind === 'check' ? ids : [],
      findingIds: answer.kind === 'avoid' ? ids : [],
    }
    if (answer.extends !== null && pendingKind.get(answer.extends) === answer.kind) {
      const known = attached.get(answer.extends)
      attached.set(answer.extends, {
        lessonId: answer.extends,
        missIds: [...new Set([...(known?.missIds ?? []), ...sources.missIds])],
        findingIds: [...new Set([...(known?.findingIds ?? []), ...sources.findingIds])],
      })
      continue
    }
    const rule = answer.rule.trim()
    const globs = answer.scope.map((glob) => glob.trim()).filter((glob) => glob !== '')
    if (rule === '' || rule.length > MAX_RULE_CHARS || globs.length === 0) continue
    const scope = scopeOf(globs.slice(0, MAX_GLOBS), [
      ...new Set(ids.map((id) => files.get(id) ?? '')),
    ])
    created.push({ kind: answer.kind, rule, scope, ...sources })
  }
  return { created, attached: [...attached.values()] }
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
