import type { ObservedEdge } from '../store/observed-store.js'
import { readFeedbackStats } from './read-history.js'
import type { HistoryReader, RepoStats, RuleStats } from './read-history.js'

export type ObservedRead = { state: 'read'; edges: ObservedEdge[] } | { state: 'unreadable' }

export interface LearningsReaders {
  history: Pick<HistoryReader, 'findings'> | undefined
  observedRepos(): Promise<string[]>
  readObserved(repo: string): Promise<ObservedRead>
}

export interface RepoLearnings {
  repo: string
  observed: ObservedRead | { state: 'none' }
  feedback: RepoStats | null
  rules: RuleStats[]
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
    const found = repos.get(key) ?? { repo, observed: { state: 'none' }, feedback: null, rules: [] }
    repos.set(key, found)
    return found
  }
  for (const feedback of stats.repos) entry(feedback.repo).feedback = feedback
  for (const rule of stats.rules) entry(rule.repo).rules.push(rule)
  for (const { repo, read } of observed) entry(repo).observed = newestFirst(read)
  return {
    recorded: readers.history !== undefined,
    repos: [...repos.values()].sort((a, b) => a.repo.localeCompare(b.repo)),
  }
}

function newestFirst(read: ObservedRead): ObservedRead {
  if (read.state !== 'read') return read
  return {
    state: 'read',
    edges: [...read.edges].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
  }
}
