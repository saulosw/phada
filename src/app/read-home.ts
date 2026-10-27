import { errorMessage } from './error-message.js'
import { recommend } from './home-recommendation.js'
import type { Recommendation } from './home-recommendation.js'
import type { AutomationView } from './read-automation.js'
import type { HistoryFilter, ListedRun } from './read-history.js'
import type { ProviderReport, ProviderSetup } from './read-provider.js'
import type { QueueView } from './read-queue.js'
import type { RepositoryList } from './read-repositories.js'

export type GitHubTokenSource = 'GITHUB_TOKEN' | 'GH_TOKEN' | 'gh'

export type GitHubAccount =
  { state: 'found'; login: string } | { state: 'refused' } | { state: 'failed'; error: string }

export type GitHubAccess = { source: null } | { source: GitHubTokenSource; account: GitHubAccount }

export type Fact<T> =
  { status: 'loading' } | { status: 'ready'; value: T } | { status: 'failed'; error: string }

export interface HomeLocal {
  automation: Fact<AutomationView>
  queue: Fact<QueueView>
  repositories: Fact<RepositoryList>
  reviews: Fact<{ runs: ListedRun[]; total: number }>
  setup: Fact<ProviderSetup>
}

export interface HomeSlow {
  github: Fact<GitHubAccess>
  providers: Fact<ProviderReport>
}

export interface HomeSnapshot extends HomeLocal, HomeSlow {
  recommendation: Recommendation
}

export interface HomeReaders {
  readAutomation(): Promise<AutomationView>
  readQueue(): Promise<QueueView>
  readRepositories(): Promise<RepositoryList>
  readReviews(filter: HistoryFilter): Promise<{ runs: ListedRun[]; total: number }>
  readProviderSetup(): Promise<ProviderSetup>
}

export const HOME_REVIEWS = 5

export async function readHomeLocal(readers: HomeReaders): Promise<HomeLocal> {
  const [automation, queue, repositories, reviews, setup] = await Promise.all([
    fact(() => readers.readAutomation()),
    fact(() => readers.readQueue()),
    fact(() => readers.readRepositories()),
    fact(() => readers.readReviews({ limit: HOME_REVIEWS })),
    fact(() => readers.readProviderSetup()),
  ])
  return { automation, queue, repositories, reviews, setup }
}

export function homeSnapshot(local: HomeLocal, slow: HomeSlow, now: Date): HomeSnapshot {
  return { ...local, ...slow, recommendation: recommend(local, slow, now) }
}

async function fact<T>(read: () => Promise<T>): Promise<Fact<T>> {
  try {
    return { status: 'ready', value: await read() }
  } catch (error) {
    return { status: 'failed', error: errorMessage(error) }
  }
}
