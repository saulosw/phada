import type { LessonList } from '../app/read-lessons.js'
import { toTerminalText } from '../app/terminal-text.js'
import type { LessonRecord, MissRecord } from '../store/history-store.js'
import { formatCount } from './units.js'

const SCHEMA_VERSION = 1
const INDENT = '      '

export function formatLessonsText({ lessons, hidden }: LessonList, all: boolean): string {
  const shownHidden = all ? 0 : hidden
  if (lessons.length === 0 && shownHidden === 0) {
    return 'No lessons in the history yet; phada lessons --refresh proposes them from the misses.\n'
  }
  const blocks = lessons.map((lesson) => lessonLines(lesson).join('\n'))
  if (shownHidden > 0) {
    blocks.push(
      `${formatCount(shownHidden, 'accepted or discarded lesson', 'accepted or discarded lessons')} not shown; add --all to see ${shownHidden === 1 ? 'it' : 'them'}.`,
    )
  }
  return `${blocks.join('\n\n')}\n`
}

export function formatLessonsJson({ lessons }: LessonList): string {
  return `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, lessons: lessons.map(lessonJson) }, null, 2)}\n`
}

function lessonLines(lesson: LessonRecord): string[] {
  const header = [
    String(lesson.id).padStart(4),
    lesson.repo,
    lesson.state,
    formatCount(lesson.misses.length, 'miss', 'misses'),
  ].join('  ')
  return [
    toTerminalText(header),
    ...toTerminalText(lesson.rule.trim())
      .split('\n')
      .map((line) => `${INDENT}${line.trim()}`),
    `${INDENT}${toTerminalText(`files: ${lesson.scope.join(', ')}`)}`,
    ...lesson.misses.map((miss) => `${INDENT}${toTerminalText(missLink(miss))}`),
  ]
}

function missLink(miss: MissRecord): string {
  return threadUrlOf(miss) ?? `${miss.repo}#${miss.number} ${miss.file}:${miss.line}`
}

function threadUrlOf(miss: MissRecord): string | null {
  return miss.threadUrl === undefined || miss.threadUrl === '' ? null : miss.threadUrl
}

function lessonJson(lesson: LessonRecord) {
  return {
    id: lesson.id,
    repo: lesson.repo,
    state: lesson.state,
    rule: lesson.rule,
    scope: lesson.scope,
    provider: lesson.provider ?? null,
    model: lesson.model ?? null,
    createdAt: lesson.createdAt,
    decidedAt: lesson.decidedAt ?? null,
    misses: lesson.misses.map((miss) => ({
      id: miss.id,
      number: miss.number,
      file: miss.file,
      line: miss.line,
      author: miss.author,
      role: miss.role ?? null,
      threadUrl: threadUrlOf(miss),
    })),
  }
}
