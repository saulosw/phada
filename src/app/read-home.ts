import type { AutomationView } from './read-automation.js'
import type { ListedRun } from './read-history.js'
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
