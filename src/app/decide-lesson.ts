import { join } from 'node:path'
import { lessonDraftText, readLessonDraft } from '../config/lesson-draft.js'
import type { LessonText } from '../config/lesson-draft.js'
import type { LocalFileSystem } from '../config/local-files.js'
import { userRepoDir } from '../config/user-config.js'
import { planUserConfigEdit } from '../config/user-config-edit.js'
import type { PlannedUserConfig } from '../config/user-config-edit.js'
import type {
  HistoryStore,
  LessonDecision,
  LessonKind,
  LessonRecord,
} from '../store/history-store.js'
import { lessonRuleId, lessonThreads } from './lesson-rule.js'

export type LessonDecider = Pick<HistoryStore, 'lessons' | 'decideLesson'>

export interface AcceptLessonDeps {
  history: LessonDecider
  files: Pick<LocalFileSystem, 'readText' | 'writeAtomic'>
  env: NodeJS.ProcessEnv
  home: string
  template: (repo: string) => string
  now: () => string
}

export interface DiscardLessonDeps {
  history: LessonDecider
  now: () => string
}

export interface AcceptedLesson {
  lessonId: number
  repo: string
  kind: LessonKind
  ruleId: string
  path: string
  created: boolean
}

export class LessonNotFoundError extends Error {
  override readonly name = 'LessonNotFoundError'

  constructor(id: number) {
    super(`No lesson ${id} in the history.`)
  }
}

export class LessonDecidedError extends Error {
  override readonly name = 'LessonDecidedError'

  constructor(id: number, state: LessonRecord['state']) {
    super(`Lesson ${id} is already ${state}.`)
  }
}

export class LessonRuleRefusedError extends Error {
  override readonly name = 'LessonRuleRefusedError'
}

export class InvalidLessonEditError extends Error {
  override readonly name = 'InvalidLessonEditError'

  constructor(id: number, message: string) {
    super(
      `The edited lesson is not valid (${message}); nothing written, lesson ${id} is still pending.`,
    )
  }
}

export function lessonConfigPath(env: NodeJS.ProcessEnv, home: string, repo: string): string {
  const [owner = '', name = ''] = repo.split('/')
  return join(userRepoDir(env, home, owner, name), 'config.yml')
}

export type LessonEditor = (draft: string) => Promise<string | undefined>

export async function acceptLesson(
  id: number,
  deps: AcceptLessonDeps,
  edit?: LessonEditor,
): Promise<AcceptedLesson | undefined> {
  const lesson = pendingLesson(id, deps.history)
  const from = lessonThreads(lesson)
  const text = edit === undefined ? lesson : await editedText(lesson, from, edit)
  if (text === undefined) return undefined
  const path = lessonConfigPath(deps.env, deps.home, lesson.repo)
  const ruleId = lessonRuleId(lesson.id)
  const current = await deps.files.readText(path)
  const planned = planUserConfigEdit({
    path,
    current: current ?? deps.template(lesson.repo),
    template: '',
    changes: [
      {
        kind: 'rule',
        rule: {
          id: ruleId,
          ...(lesson.kind === 'avoid' ? { kind: 'avoid' as const } : {}),
          rule: text.rule,
          scope: text.scope,
          from,
        },
      },
    ],
  })
  if (!planned.ok) throw new LessonRuleRefusedError(refusalText(planned, path))
  await deps.files.writeAtomic(path, planned.plan.text)
  const changed = edit === undefined ? undefined : { rule: text.rule, scope: text.scope }
  decide(lesson.id, 'accepted', deps, changed)
  return {
    lessonId: lesson.id,
    repo: lesson.repo,
    kind: lesson.kind,
    ruleId,
    path,
    created: current === null,
  }
}

async function editedText(
  lesson: LessonRecord,
  from: readonly string[],
  edit: LessonEditor,
): Promise<LessonText | undefined> {
  const saved = await edit(lessonDraftText({ ...lesson, from }))
  if (saved === undefined) return undefined
  const read = readLessonDraft(saved)
  if (read.kind === 'invalid') throw new InvalidLessonEditError(lesson.id, read.message)
  return read.kind === 'edited' ? read.lesson : undefined
}

export function discardLesson(id: number, deps: DiscardLessonDeps): void {
  decide(id, 'discarded', deps)
}

function decide(
  id: number,
  decision: LessonDecision,
  deps: DiscardLessonDeps,
  edit?: LessonText,
): void {
  if (deps.history.decideLesson(id, decision, deps.now(), edit)) return
  const [lesson] = deps.history.lessons({ id })
  throw lesson === undefined
    ? new LessonNotFoundError(id)
    : new LessonDecidedError(id, lesson.state)
}

function pendingLesson(id: number, history: LessonDecider): LessonRecord {
  const [lesson] = history.lessons({ id })
  if (lesson === undefined) throw new LessonNotFoundError(id)
  if (lesson.state !== 'pending') throw new LessonDecidedError(id, lesson.state)
  return lesson
}

function refusalText(refusal: Exclude<PlannedUserConfig, { ok: true }>, path: string): string {
  switch (refusal.reason) {
    case 'rule-exists':
      return `${path} already has a rule ${refusal.id}; rename or remove it, then accept again.`
    case 'invalid-config':
      return `${path} is not a valid config (${refusal.message}); fix it first.`
    case 'invalid-result':
      return `The lesson would leave ${path} invalid (${refusal.message}).`
    default:
      return `Could not add the lesson to ${path} (${refusal.reason}).`
  }
}
