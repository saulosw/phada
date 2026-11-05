import { acceptLesson, discardLesson, LessonNotFoundError } from '../app/decide-lesson.js'
import { proposeLessons } from '../app/propose-lessons.js'
import type { LessonSetup, ProposeLessonsDeps } from '../app/propose-lessons.js'
import { readLessons } from '../app/read-lessons.js'
import { toTerminalText } from '../app/terminal-text.js'
import { dataFiles } from '../config/data-paths.js'
import type { LocalFileSystem } from '../config/local-files.js'
import { mergeConfig, resolveProvider } from '../config/merge-config.js'
import { loadTopLevelUserLayers, loadUserLayers } from '../config/user-config.js'
import { historyEnabled } from '../config/watch-settings.js'
import { splitRepoName } from '../github/pull-request-ref.js'
import type { ReviewProvider } from '../providers/types.js'
import type { HistoryStore } from '../store/history-store.js'
import type { IndexFormat, RepositoryName } from './args.js'
import { UsageError } from './errors.js'
import { formatLessonsJson, formatLessonsText } from './format-lessons.js'
import { existingHistory } from './history-access.js'
import { userRepoConfigTemplate } from './init-templates.js'
import type { TextOutput } from './progress.js'
import { assertProviderChoice } from './provider-choice.js'
import type { ProviderOptions } from './provider-choice.js'
import { textEditor } from './text-editor.js'
import type { TextEditorDeps } from './text-editor.js'
import { formatCount } from './units.js'

export interface LessonsCommand {
  repo?: RepositoryName
  all: boolean
  refresh: boolean
  format: IndexFormat
}

export interface LessonDecisionCommand {
  id: number
}

export interface LessonAcceptCommand extends LessonDecisionCommand {
  edit: boolean
}

export interface LessonsCommandDeps extends TextEditorDeps {
  home: string
  files: LocalFileSystem
  stdout: TextOutput
  stderr: TextOutput
  clock: () => Date
  openHistoryStore: (path: string) => Promise<HistoryStore>
  createProvider: (name: string, options: ProviderOptions) => ReviewProvider
}

export async function runLessons(command: LessonsCommand, deps: LessonsCommandDeps): Promise<void> {
  if (command.refresh && !historyEnabled(await loadTopLevelUserLayers(deps))) {
    throw new UsageError('--refresh saves to the history; remove history: false from your config.')
  }
  const filter =
    command.repo === undefined ? {} : { repo: `${command.repo.owner}/${command.repo.repo}` }
  const history = await existingHistory(dataFiles(deps.env, deps.home).history, deps)
  try {
    if (history !== undefined && command.refresh) {
      await proposeLessons(filter, {
        history,
        setup: (repo) => lessonSetup(repo, deps),
        now: () => deps.clock().toISOString(),
        events: progressLines(deps),
      })
    }
    const list = readLessons(history, filter, command.all)
    deps.stdout.write(
      command.format === 'json' ? formatLessonsJson(list) : formatLessonsText(list, command.all),
    )
  } finally {
    history?.close()
  }
}

export async function runLessonsAccept(
  command: LessonAcceptCommand,
  deps: LessonsCommandDeps,
): Promise<void> {
  const history = await existingHistory(dataFiles(deps.env, deps.home).history, deps)
  if (history === undefined) throw new LessonNotFoundError(command.id)
  try {
    const accepted = await acceptLesson(
      command.id,
      {
        history,
        files: deps.files,
        env: deps.env,
        home: deps.home,
        template: userRepoConfigTemplate,
        now: () => deps.clock().toISOString(),
      },
      command.edit ? textEditor(deps, `lesson-${command.id}.yml`) : undefined,
    )
    if (accepted === undefined) {
      deps.stderr.write(
        `Accept cancelled; nothing written, lesson ${command.id} is still pending.\n`,
      )
      return
    }
    const written = accepted.created
      ? `Created ${accepted.path} with the rule ${accepted.ruleId}`
      : `Added the rule ${accepted.ruleId} to ${accepted.path}`
    deps.stderr.write(
      toTerminalText(`${written}; reviews of ${accepted.repo} apply it from now on.`) + '\n',
    )
  } finally {
    history.close()
  }
}

export async function runLessonsDiscard(
  command: LessonDecisionCommand,
  deps: LessonsCommandDeps,
): Promise<void> {
  const history = await existingHistory(dataFiles(deps.env, deps.home).history, deps)
  if (history === undefined) throw new LessonNotFoundError(command.id)
  try {
    discardLesson(command.id, { history, now: () => deps.clock().toISOString() })
    deps.stderr.write(`Discarded lesson ${command.id}; phada lessons no longer lists it.\n`)
  } finally {
    history.close()
  }
}

async function lessonSetup(repo: string, deps: LessonsCommandDeps): Promise<LessonSetup> {
  const userLayers = await loadUserLayers({ ...deps, ...splitRepoName(repo) })
  const choice = resolveProvider({}, userLayers)
  const options = choice.model === undefined ? {} : { model: choice.model }
  assertProviderChoice(choice.provider, options, 'config')
  const config = mergeConfig(userLayers)
  return {
    provider: deps.createProvider(choice.provider, options),
    rules: config.rules
      .filter(({ key }) => !config.disabledRules.has(key))
      .map(({ key, scope, text }) => ({ key, scope, text })),
  }
}

function progressLines(deps: LessonsCommandDeps): ProposeLessonsDeps['events'] {
  const write = (line: string) => deps.stderr.write(`${toTerminalText(line)}\n`)
  return {
    proposing: (repo, misses) =>
      write(
        `Proposing lessons for ${repo} from ${formatCount(misses, 'new miss', 'new misses')} with your AI…`,
      ),
    proposed: ({ repo, created, attached }) =>
      write(
        `${repo}: ${formatCount(created, 'new lesson')}, ${formatCount(attached, 'miss', 'misses')} added to pending lessons.`,
      ),
  }
}
