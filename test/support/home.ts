import type { AutomationView } from '../../src/app/read-automation.js'
import type { ListedRun } from '../../src/app/read-history.js'
import type { GitHubAccess, HomeLocal, HomeSlow } from '../../src/app/read-home.js'
import type {
  ProviderReport,
  ProviderSetup,
  ReportedProvider,
} from '../../src/app/read-provider.js'
import type { QueueView } from '../../src/app/read-queue.js'
import type { ListedRepository, RepositoryList } from '../../src/app/read-repositories.js'
import type { JobRecord } from '../../src/watch/types.js'
import { CONFIG_FILE, emptyAutomation, emptyQueue, NOW } from './tui.js'

export const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

export function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString()
}

export function homeJob(id: number, changes: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    repo: 'acme/shop',
    number: id,
    headSha: SHA,
    status: 'queued',
    attempts: 0,
    notBefore: minutesAgo(5),
    createdAt: minutesAgo(5),
    ...changes,
  }
}

export function homeRun(number: number, changes: Partial<ListedRun> = {}): ListedRun {
  return {
    id: number,
    source: 'watch',
    repo: 'acme/shop',
    number,
    headSha: SHA,
    startedAt: minutesAgo(number * 10),
    finishedAt: minutesAgo(number * 10 - 1),
    status: 'published',
    aiCalled: true,
    provider: 'claude',
    score: 4,
    findings: 2,
    verdict: 'comments',
    title: `Change number ${number}`,
    ...changes,
  }
}

export function watchedRepository(repo: string, indexed: boolean): ListedRepository {
  return {
    repo,
    origins: ['watched'],
    publish: 'pr',
    index: {
      file: indexed ? { path: `/cache/${repo}/index.sqlite`, bytes: 2048 } : null,
      indexedSha: indexed ? SHA : null,
      checkedAt: indexed ? minutesAgo(30) : null,
    },
    lastReview: null,
  }
}

export function configuredAutomation(): AutomationView {
  return {
    ...emptyAutomation(),
    configured: true,
    watch: { intervalMs: 300_000, settleMs: 180_000, maxReviewsPerHour: 6, repos: ['acme/shop'] },
  }
}

export function runningQueue(): QueueView {
  return {
    ...emptyQueue(),
    recorded: true,
    holder: { pid: 4242 },
    hourly: { count: 1, max: 6 },
    lastCycleAt: minutesAgo(2),
    nextCycle: { at: new Date(NOW.getTime() + 3 * 60_000).toISOString(), estimated: true },
  }
}

export function homeRepositories(repositories: ListedRepository[]): RepositoryList {
  return {
    configFile: CONFIG_FILE,
    configured: true,
    configError: null,
    watching: true,
    repositories,
  }
}

export function claudeSetup(model: string | null = 'opus'): ProviderSetup {
  return {
    choice: { provider: 'claude', model, origin: { kind: 'user-config', path: CONFIG_FILE } },
    mcp: [],
  }
}

export function loggedInClaude(): Extract<ReportedProvider, { provider: 'claude' | 'codex' }> {
  return {
    provider: 'claude',
    install: { state: 'installed', version: '2.1.0' },
    login: { state: 'logged-in', method: 'claude.ai' },
    chosen: true,
    next: null,
  }
}

export function providerReport(providers: ReportedProvider[]): ProviderReport {
  return { choice: claudeSetup().choice, providers }
}

export const FOUND_GITHUB: GitHubAccess = {
  source: 'GITHUB_TOKEN',
  account: { state: 'found', login: 'ana' },
}

export function healthyLocal(): HomeLocal {
  return {
    automation: { status: 'ready', value: configuredAutomation() },
    queue: { status: 'ready', value: runningQueue() },
    repositories: {
      status: 'ready',
      value: homeRepositories([watchedRepository('acme/shop', true)]),
    },
    reviews: { status: 'ready', value: { runs: [homeRun(1), homeRun(2)], total: 2 } },
    setup: { status: 'ready', value: claudeSetup() },
  }
}

export function healthySlow(): HomeSlow {
  return {
    github: { status: 'ready', value: FOUND_GITHUB },
    providers: { status: 'ready', value: providerReport([loggedInClaude()]) },
  }
}
