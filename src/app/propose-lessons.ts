import type { ReviewProvider } from '../providers/types.js'
import type { AssociationRole } from '../publish/conversation.js'
import { newNonce } from '../review/nonce.js'
import { buildLessonsPrompt } from '../review/lessons-prompt.js'
import type { KnownRule } from '../review/lessons-prompt.js'
import { parseLessons } from '../review/parse-lessons.js'
import type { HistoryStore, MissRecord } from '../store/history-store.js'
import { checkLessonAnswers } from './lesson-answers.js'

const TEAM_ROLES: ReadonlySet<AssociationRole> = new Set(['owner', 'member', 'collaborator'])
const MISSES_PER_PASS = 50

export interface LessonSetup {
  provider: ReviewProvider
  rules: readonly KnownRule[]
}

export interface RepositoryLessons {
  repo: string
  sent: number
  created: number
  attached: number
}

export interface ProposeLessonsDeps {
  history: Pick<HistoryStore, 'misses' | 'lessons' | 'linkedMissIds' | 'recordLessons'>
  setup: (repo: string) => Promise<LessonSetup>
  now: () => string
  events: {
    proposing: (repo: string, misses: number) => void
    proposed: (result: RepositoryLessons) => void
  }
}

export async function proposeLessons(
  filter: { repo?: string },
  deps: ProposeLessonsDeps,
): Promise<RepositoryLessons[]> {
  const byRepo = eligibleMisses(deps.history, filter.repo)
  if (filter.repo !== undefined && !byRepo.has(filter.repo.toLowerCase())) {
    return [{ repo: filter.repo.toLowerCase(), sent: 0, created: 0, attached: 0 }]
  }
  const results: RepositoryLessons[] = []
  for (const [repo, misses] of [...byRepo].sort(([a], [b]) => a.localeCompare(b))) {
    deps.events.proposing(repo, misses.length)
    const result = await proposeFor(repo, misses, deps)
    deps.events.proposed(result)
    results.push(result)
  }
  return results
}

function eligibleMisses(
  history: ProposeLessonsDeps['history'],
  repo: string | undefined,
): Map<string, MissRecord[]> {
  const linked = history.linkedMissIds()
  const { misses } = history.misses({ ...(repo === undefined ? {} : { repo }), state: 'open' })
  const byRepo = new Map<string, MissRecord[]>()
  for (const miss of misses) {
    if (miss.origin !== 'person' || miss.role === undefined || !TEAM_ROLES.has(miss.role)) continue
    if (linked.has(miss.id)) continue
    const kept = byRepo.get(miss.repo) ?? []
    if (kept.length < MISSES_PER_PASS) byRepo.set(miss.repo, [...kept, miss])
  }
  return byRepo
}

async function proposeFor(
  repo: string,
  misses: readonly MissRecord[],
  deps: ProposeLessonsDeps,
): Promise<RepositoryLessons> {
  const { provider, rules } = await deps.setup(repo)
  const pending = deps.history.lessons({ repo, states: ['pending'] })
  const output = await provider.review(
    buildLessonsPrompt(
      {
        repo,
        misses: misses.map(({ id, number, file, line, role, body }) => ({
          id,
          number,
          file,
          line,
          role: role ?? '',
          body,
        })),
        pending: pending.map(({ id, rule, scope }) => ({ id, rule, scope })),
        rules,
      },
      newNonce(),
    ),
  )
  const changes = checkLessonAnswers(
    parseLessons(output.text),
    misses,
    new Set(pending.map(({ id }) => id)),
  )
  deps.history.recordLessons(
    {
      repo,
      provider: provider.id,
      ...(output.model === undefined ? {} : { model: output.model }),
      ...changes,
    },
    deps.now(),
  )
  return {
    repo,
    sent: misses.length,
    created: changes.created.length,
    attached: changes.attached.reduce((total, { missIds }) => total + missIds.length, 0),
  }
}
