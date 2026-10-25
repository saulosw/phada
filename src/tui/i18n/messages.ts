import type { FeedbackFinding, ListedRun, ReviewDetail } from '../../app/read-history.js'
import type { McpServerKind, NextStep } from '../../app/read-provider.js'
import type { QueueJob } from '../../app/read-queue.js'
import type { RepositoryOrigin, SettingOrigin } from '../../app/read-repositories.js'
import type { TimeMessages } from '../relative-time.js'
import { english } from './en.js'
import { spanish } from './es.js'
import { portuguese } from './pt.js'

export type ScreenId =
  'home' | 'repositories' | 'rules' | 'reviews' | 'queue' | 'automation' | 'provider' | 'learnings'

export interface ScreenTitle {
  full: string
  short: string
}

export interface UiMessages {
  screens: Readonly<Record<ScreenId, ScreenTitle>>
  keys: {
    screens: string
    cycle: string
    jump: string
    palette: string
    help: string
    back: string
    quit: string
    more: string
    select: string
    open: string
    close: string
    refresh: string
  }
  help: { title: string; global: string }
  palette: { title: string; empty: string }
  tooSmall(columns: number, rows: number): string
  tooSmallHint: string
  placeholder: string
  home: { tagline: string }
  loading: string
  failed(message: string): string
  time: TimeMessages
  list: { range(first: number, last: number, total: number): string; scroll: string }
  field: { apply: string; cancel: string }
  requests: {
    sources: Readonly<Record<RequestSource, string>>
    publish: Readonly<Record<QueueJob['requests'][number]['publish'], string>>
    author(login: string): string
    channel(id: string): string
  }
  queue: QueueMessages
  reviews: ReviewsMessages
  settings: SettingsMessages
  repositories: RepositoriesMessages
  automation: AutomationMessages
  provider: ProviderMessages
  learnings: LearningsMessages
}

type RequestSource = QueueJob['requests'][number]['source']
export type QueueRowKind = 'running' | 'waiting' | 'queued' | 'skipped' | 'failed'

export interface QueueMessages {
  running(pid: number): string
  stopped: string
  lastCycle(when: string): string
  next(when: string): string
  startWith: string
  paused(until: string, relative: string, reason: string): string
  pauseReasons: { rateLimit: string; usageLimit: string }
  hourly(count: number, max: number): string
  never: string
  empty: string
  kinds: Readonly<Record<QueueRowKind, string>>
  statuses: Readonly<Record<QueueJob['job']['status'], string>>
  started(when: string): string
  starts(when: string): string
  ready: string
  attempt(number: number): string
  ciUntil(when: string): string
  pending(count: number, names: string): string
  noChecks: string
  failing(names: string): string
  checked(when: string): string
  askedFrom(sources: string): string
  detail: {
    created: string
    notBefore: string
    started: string
    finished: string
    ciDeadline: string
    pending: string
    failing: string
    checked: string
    attempts: string
    error: string
    publish: string
    requests(count: number): string
    gone: string
  }
}

export type ReviewSource = ListedRun['source'] | NonNullable<ListedRun['requestSource']>

export interface ReviewsMessages {
  count(total: number): string
  latest(shown: number): string
  filter: string
  columns: {
    pr: string
    verdict: string
    score: string
    findings: string
    when: string
    source: string
  }
  none: string
  noneHint: string
  or: string
  noMatch(text: string): string
  verdicts: Readonly<Record<NonNullable<ReviewDetail['verdict']>, string>>
  statuses: Readonly<Record<ListedRun['status'], string>>
  sources: Readonly<Record<ReviewSource, string>>
  ciStates: Readonly<Record<string, string>>
  outcomes: Readonly<Record<FeedbackFinding['destination'], string>>
  marks: Readonly<Record<FeedbackFinding['marks'][number], string>>
  detail: {
    score: string
    verdict: string
    status: string
    reviewed: string
    ci: string
    failing(names: string): string
    pending(names: string): string
    published: string
    comments(count: number): string
    error: string
    summary: string
    findings(count: number): string
    worthChecking(count: number): string
    feedback(count: number): string
    gone: string
  }
}

export interface SettingsMessages {
  origins: Readonly<Record<SettingOrigin, string>>
  on: string
  off: string
  notSet: string
  allChecks: string
  cliDefault: string
  noConfig: string
  initHint: string
  invalid(message: string): string
}

export interface RepositoriesMessages {
  count(total: number): string
  watched(count: number): string
  columns: { repo: string; origin: string; index: string; last: string }
  origins: Readonly<Record<RepositoryOrigin, string>>
  noIndex: string
  nothingWatched: string
  nothingWatchedHint(file: string): string
  then: string
  detail: {
    watch: string
    notWatched(file: string): string
    publish: string
    authors: string
    labels: string
    baseBranches: string
    external: string
    externalAllowed: string
    externalRefused: string
    when: string
    index: string
    file: string
    commit: string
    checked(when: string): string
    noIndex: string
    config: string
    rules(count: number): string
    repositoryCanChange: string
    related: string
    noRelated: string
    reviews(shown: number, total: number): string
    noReviews: string
  }
}

export interface AutomationMessages {
  watch: string
  interval: string
  settle: string
  perHour: string
  perHourValue(count: number): string
  repos: string
  watchOff(file: string): string
  ci: string
  ciNote: string
  sources: string
  prComments: string
  enqueue: string
  mcp: string
  slack: string
  needsWatch: string
  slackChannels(count: number): string
  slackPublish: Readonly<Record<'pr' | 'none', string>>
  slackReply: Readonly<Record<'link' | 'summary' | 'full', string>>
  token(name: string, set: boolean): string
  hooks: string
  timeout(duration: string): string
  noHooks(file: string): string
  when: string
  whenAll: string
  noWhen: string
}

export type StatusProblemCode =
  'timeout' | 'failed' | 'unexpected-output' | 'invalid-host' | 'not-installed'

export interface ProviderMessages {
  reviewsWith: string
  model(name: string): string
  cliDefault: string
  ollamaModel: string
  from(path: string): string
  fromDefault: string
  perRepo: string
  providers: string
  checking: string
  chosen: string
  installed(version: string | null): string
  notInstalled: string
  loggedIn(method: string | null): string
  loggedOut: string
  running(version: string | null): string
  stopped: string
  models(count: number, names: string): string
  noModels: string
  installUnknown(problem: string): string
  loginUnknown(problem: string): string
  serverUnknown(problem: string): string
  problems: Readonly<Record<StatusProblemCode, string>>
  steps: Readonly<Record<NextStep['kind'], string>>
  mcp(count: number): string
  mcpNone: string
  mcpKinds: Readonly<Record<McpServerKind, string>>
  tools(names: string): string
}

export interface LearningsMessages {
  title(repos: number): string
  aboutRelations: string
  aboutFeedback: string
  nothing: string
  noneYet: string
  hint: string
  or: string
  relations(count: number): string
  noRelations: string
  unreadable: string
  comments(count: number): string
  noComments: string
  outcome: Readonly<Record<FeedbackFinding['destination'], (count: number) => string>>
  marks(negative: number, replies: number): string
  detail: {
    published: string
    noComments: string
    byRule(count: number): string
    noRules: string
    relations(count: number): string
    noRelations: string
    unreadable: string
    gone: string
  }
}

const CATALOGS: Readonly<Record<string, UiMessages>> = {
  en: english,
  pt: portuguese,
  es: spanish,
}

export function uiMessagesFor(language: string | undefined): UiMessages {
  const base = language?.split('-', 1)[0]?.toLowerCase() ?? 'en'
  return CATALOGS[base] ?? english
}
