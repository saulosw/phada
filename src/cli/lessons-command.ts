import { acceptLesson, discardLesson } from '../app/decide-lesson.js'
import { proposeLessons } from '../app/propose-lessons.js'
import type { LessonBatchSize, LessonSetup, ProposeLessonsDeps } from '../app/propose-lessons.js'
import { readLessons } from '../app/read-lessons.js'
import { toTerminalText } from '../app/terminal-text.js'
import { dataFiles } from '../config/data-paths.js'
import { mergeConfig } from '../config/merge-config.js'
import { loadTopLevelUserLayers } from '../config/user-config.js'
import { historyEnabled } from '../config/watch-settings.js'
import { splitRepoName } from '../github/pull-request-ref.js'
import type { ReviewProvider } from '../providers/types.js'
import type { IndexFormat, RepositoryName } from './args.js'
import { formatLessonsJson, formatLessonsText } from './format-lessons.js'
import { existingHistory } from './history-access.js'
import { refreshToken } from './history-refresh.js'
import { withLessonHistory } from './lesson-history.js'
import { assertProviderChoice, loadProviderChoice, modelOption } from './provider-choice.js'
import type { ProviderOptions } from './provider-choice.js'
import { textEditor } from './text-editor.js'
import type { TextEditorDeps } from './text-editor.js'
import { harvestTeamComments } from './team-harvest.js'
import type { TeamHarvestDeps } from './team-harvest.js'
import { formatCount } from './units.js'

export interface LessonsCommand {
  repo?: RepositoryName
  all: boolean
  refresh: boolean
  since?: string
  format: IndexFormat
}

export interface LessonDecisionCommand {
  id: number
}

export interface LessonAcceptCommand extends LessonDecisionCommand {
  edit: boolean
}

export interface LessonsCommandDeps extends TextEditorDeps, TeamHarvestDeps {
  createProvider: (name: string, options: ProviderOptions) => ReviewProvider
}

export async function runLessons(command: LessonsCommand, deps: LessonsCommandDeps): Promise<void> {
  const token = command.refresh
    ? await refreshToken(deps, historyEnabled(await loadTopLevelUserLayers(deps)))
    : undefined
  const filter =
    command.repo === undefined ? {} : { repo: `${command.repo.owner}/${command.repo.repo}` }
  const path = dataFiles(deps.env, deps.home).history
  const history =
    token === undefined ? await existingHistory(path, deps) : await deps.openHistoryStore(path)
  try {
    if (history !== undefined && token !== undefined) {
      const repos = filter.repo === undefined ? history.runRepos() : [filter.repo]
      await harvestTeamComments(history, repos, token, deps, command.since)
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
  const editor = command.edit ? textEditor(deps, `lesson-${command.id}.yml`) : undefined
  const accepted = await withLessonHistory(command.id, deps, (lessonDeps) =>
    acceptLesson(command.id, lessonDeps, editor),
  )
  if (accepted === undefined) {
    deps.stderr.write(`Accept cancelled; nothing written, lesson ${command.id} is still pending.\n`)
    return
  }
  const rule = `${accepted.kind === 'avoid' ? 'avoid rule' : 'rule'} ${accepted.ruleId}`
  const written = accepted.created
    ? `Created ${accepted.path} with the ${rule}`
    : `Added the ${rule} to ${accepted.path}`
  const effect =
    accepted.kind === 'avoid'
      ? `reviews of ${accepted.repo} stop reporting what it describes in its files from now on`
      : `reviews of ${accepted.repo} apply it from now on`
  deps.stderr.write(toTerminalText(`${written}; ${effect}.`) + '\n')
}

export async function runLessonsDiscard(
  command: LessonDecisionCommand,
  deps: LessonsCommandDeps,
): Promise<void> {
  await withLessonHistory(command.id, deps, (lessonDeps) => discardLesson(command.id, lessonDeps))
  deps.stderr.write(`Discarded lesson ${command.id}; phada lessons no longer lists it.\n`)
}

async function lessonSetup(repo: string, deps: LessonsCommandDeps): Promise<LessonSetup> {
  const { userLayers, choice } = await loadProviderChoice(splitRepoName(repo), {}, deps)
  const options = modelOption(choice)
  assertProviderChoice(choice.provider, options, 'config')
  const config = mergeConfig(userLayers)
  return {
    provider: deps.createProvider(choice.provider, options),
    rules: config.rules
      .filter(({ key }) => !config.disabledRules.has(key))
      .map(({ key, kind, scope, text }) => ({ key, kind: kind ?? 'check', scope, text })),
  }
}

function progressLines(deps: LessonsCommandDeps): ProposeLessonsDeps['events'] {
  const write = (line: string) => deps.stderr.write(`${toTerminalText(line)}\n`)
  return {
    proposing: (repo, batch) =>
      write(`Proposing lessons for ${repo} from ${batchText(batch)} with your AI…`),
    proposed: ({ repo, created, attached, attachedFindings }) =>
      write(
        `${repo}: ${formatCount(created, 'new lesson')}, ${formatCount(attached, 'miss', 'misses')}${attachedFindings === 0 ? '' : ` and ${formatCount(attachedFindings, 'Phada comment')}`} added to pending lessons.`,
      ),
  }
}

function batchText({ fresh, earlier, freshFindings, earlierFindings }: LessonBatchSize): string {
  return [
    entriesText(fresh, earlier, 'miss', 'misses'),
    entriesText(freshFindings, earlierFindings, 'Phada comment', 'Phada comments'),
  ]
    .filter((text) => text !== '')
    .join(' plus ')
}

function entriesText(fresh: number, earlier: number, noun: string, plural: string): string {
  if (fresh === 0) {
    return earlier === 0 ? '' : formatCount(earlier, `earlier ${noun}`, `earlier ${plural}`)
  }
  const added = formatCount(fresh, `new ${noun}`, `new ${plural}`)
  return earlier === 0
    ? added
    : `${added} and ${formatCount(earlier, 'earlier one', 'earlier ones')}`
}
