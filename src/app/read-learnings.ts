import type { HistoryStore, LessonRecord, MissRecord } from '../store/history-store.js'
import type { ObservedEdge } from '../store/observed-store.js'
import { latestTally } from './miss-tally.js'
import type { VersionTally } from './miss-tally.js'
import { readFeedbackStats } from './read-history.js'
import { readLessons } from './read-lessons.js'
import type { RepoStats, RuleStats } from './read-history.js'

export type ObservedRead = { state: 'read'; edges: ObservedEdge[] } | { state: 'unreadable' }

export interface LearningsReaders {
  history:
    Pick<HistoryStore, 'findings' | 'replies' | 'misses' | 'missReplays' | 'lessons'> | undefined
  observedRepos(): Promise<string[]>
  readObserved(repo: string): Promise<ObservedRead>
  lessonFile(repo: string): string
}

export interface RepoLearnings {
  repo: string
  observed: ObservedRead | { state: 'none' }
  feedback: RepoStats | null
  rules: RuleStats[]
  misses: MissCounts | null
  lessons: LessonRecord[]
  lessonFile: string
}

export interface MissCounts {
  open: number
  latest?: VersionTally
}

export interface Learnings {
  recorded: boolean
  repos: RepoLearnings[]
}

export async function readLearnings(readers: LearningsReaders): Promise<Learnings> {
  const stats = readFeedbackStats(readers.history, {})
  const observed = await Promise.all(
    (await readers.observedRepos()).map(async (repo) => ({
      repo,
      read: await readers.readObserved(repo).catch((): ObservedRead => ({ state: 'unreadable' })),
    })),
  )
  const repos = new Map<string, RepoLearnings>()
  const entry = (repo: string) => {
    const key = repo.toLowerCase()
    const found = repos.get(key) ?? {
      repo,
      observed: { state: 'none' },
      feedback: null,
      rules: [],
      misses: null,
      lessons: [],
      lessonFile: readers.lessonFile(repo),
    }
    repos.set(key, found)
    return found
  }
  for (const feedback of stats.repos) entry(feedback.repo).feedback = feedback
  for (const rule of stats.rules) entry(rule.repo).rules.push(rule)
  for (const { repo, read } of observed) entry(repo).observed = newestFirst(read)
  for (const [repo, misses] of openMisses(readers.history)) entry(repo).misses = misses
  for (const lesson of readLessons(readers.history, {}, false).lessons) {
    entry(lesson.repo).lessons.push(lesson)
  }
  return {
    recorded: readers.history !== undefined,
    repos: [...repos.values()].sort((a, b) => a.repo.localeCompare(b.repo)),
  }
}

function openMisses(history: LearningsReaders['history']): Map<string, MissCounts> {
  const open = history?.misses({ state: 'open' }).misses ?? []
  const byRepo = new Map<string, MissRecord[]>()
  for (const miss of open) byRepo.set(miss.repo, [...(byRepo.get(miss.repo) ?? []), miss])
  const counts = new Map<string, MissCounts>()
  for (const [repo, misses] of byRepo) {
    const latest = latestTally(history?.missReplays(misses.map(({ id }) => id)) ?? [])
    counts.set(repo, { open: misses.length, ...(latest === undefined ? {} : { latest }) })
  }
  return counts
}

function newestFirst(read: ObservedRead): ObservedRead {
  if (read.state !== 'read') return read
  return {
    state: 'read',
    edges: [...read.edges].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
  }
}
