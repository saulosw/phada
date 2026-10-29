import type { FeedbackFinding, ListedRun, ReviewDetail } from '../../app/read-history.js'
import type { PackageRef } from '../../app/read-connections.js'
import type { GitHubTokenSource } from '../../app/read-home.js'
import type { McpServerKind, NextStep } from '../../app/read-provider.js'
import type {
  IndexLanguage,
  IndexSymbolKind,
  IndexVersion,
  LeftOutGroup,
  RepositoryIndexState,
} from '../../app/read-index.js'
import type { QueueJob } from '../../app/read-queue.js'
import type { ReviewMode } from '../../app/requested-review.js'
import type { AiRun } from '../../app/review-progress.js'
import type { RepositoryOrigin, SettingOrigin } from '../../app/read-repositories.js'
import type { TimeMessages } from '../relative-time.js'
import { english } from './en.js'
import { spanish } from './es.js'
import { portuguese } from './pt.js'

export type ScreenId =
  | 'home'
  | 'repositories'
  | 'rules'
  | 'reviews'
  | 'queue'
  | 'automation'
  | 'provider'
  | 'graph'
  | 'learnings'

export type SetupStepId =
  'github' | 'ai' | 'language' | 'repositories' | 'graph' | 'repository' | 'summary'

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
  palette: {
    title: string
    empty: string
    setup: string
    index: string
    review: string
    watch: string
  }
  tooSmall(columns: number, rows: number): string
  tooSmallHint: string
  home: HomeMessages
  loading: string
  failed(message: string): string
  causedBy(error: string): string
  time: TimeMessages
  list: { range(first: number, last: number, total: number): string; scroll: string }
  field: { apply: string; cancel: string }
  handOff: { notFound(command: string): string; failed(message: string): string }
  quitGuard: { quit: string; stay: string; stopping: string; quitNow: string }
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
  graph: GraphMessages
  indexing: IndexingMessages
  learnings: LearningsMessages
  rules: RulesMessages
  setup: SetupMessages
  language: { title: string; intro: string; current: string; choose: string }
  config: ConfigMessages
  reviewFlow: ReviewFlowMessages
}

export interface ReviewFlowMessages {
  title: string
  start: string
  pullRequest: string
  typeHint: string
  notAPullRequest(text: string): string
  repositories: string
  noRepositories: string
  type: string
  openPulls(repo: string): string
  noOpenPulls: string
  noToken: string
  draft: string
  chooseMode: string
  modes: Readonly<Record<ReviewMode, { label: string; hint: string }>>
  queueMode: { label: string; hint(pid: number): string }
  confirm: {
    question: string
    pullRequest: string
    as: string
    publish: string
    queueQuestion: string
    queue: string
    watch: string
    watchRunning(pid: number): string
  }
  enqueue: {
    submitting: string
    queued(job: number, sha: string): string
    joined(job: number, sha: string): string
    refused(reason: string): string
    refusals: {
      notWatched: string
      closed: string
      external: string
      whenCommand(message: string): string
      noReason: string
      alreadyReviewed: string
      alreadyReviewedJob(job: number): string
      hourlyLimit: string
      hourlyLimitUntil(until: string): string
    }
    failed: string
    openQueue: string
  }
  running: Readonly<Record<ReviewMode, string>>
  notices: { closed: string; draft: string }
  steps: {
    fetching(ref: string): string
    fetched(title: string): string
    context(rules: number, docs: number): string
    conversation(items: number): string
    ci(state: string): string
    ciWaiting(pending: number): string
    ciWaited: string
    indexing(done: number, total: number): string
    related(count: number): string
    impact(symbols: number): string
    pass(skill: string, index: number, total: number): string
    ai(provider: string, run: string, elapsed: string): string
    noAnswer: string
    publishing: string
  }
  runs: Readonly<Record<AiRun, string>>
  warnings(count: number): string
  moreWarnings(count: number): string
  done(elapsed: string): string
  failed: string
  cancel: {
    key: string
    question: string
    confirm: string
    keep: string
    cancelling: string
    cancelled: string
  }
  quitWhileRunning: string
  history: {
    saved: string
    off: string
    notSaved(error: string): string
    feedbackNotSaved(error: string): string
  }
}

export interface HomeMessages {
  tagline: string
  labels: { github: string; ai: string; watch: string; queue: string; graph: string }
  checking: string
  github: {
    sources: Readonly<Record<GitHubTokenSource, string>>
    refused: string
    noToken: string
  }
  defaultModel: string
  watch: {
    running(pid: number): string
    stopped: string
    notConfigured: string
    lastCycle(when: string): string
    next(when: string): string
  }
  queue: {
    running(count: number): string
    queued(count: number): string
    waiting(count: number): string
    failed(count: number): string
    skipped(count: number): string
    paused(until: string, relative: string): string
    empty: string
  }
  graph: { indexed(count: number): string; missing(count: number): string; none: string }
  recommendations: {
    checking(github: boolean, ai: boolean): string
    fixConfig(file: string): string
    githubToken: string
    githubRefused(source: string): string
    setup: string
    ai: Readonly<Record<NextStep['kind'], (provider: string) => string>>
    paused(until: string, relative: string, reason: string): string
    failedJobs(count: number, ref: string, error: string | null): string
    ciSkipped(count: number, ref: string, failing: string): string
    index(repo: string, count: number): string
    slackTokens(names: readonly string[]): string
    watch: string
    review: string
  }
  reviews: { title: string; none: string }
}

export interface SetupMessages {
  title: ScreenTitle
  step(number: number, total: number): string
  steps: Readonly<Record<SetupStepId, string>>
  skip: string
  leave: string
  stay: string
  leaveQuestion: string
  leaveHint: string
  continue: string
  github: {
    checking: string
    found(source: string, login: string): string
    readsAs(login: string): string
    noToken: string
    why: string
    logIn: string
    refused(source: string): string
    replace(variable: string): string
    unreachable(message: string): string
    notInstalled: string
  }
  ai: { intro: string }
  repositories: { intro: string; noToken: string }
  graph: {
    reading: string
    intro: string
    none: string
    index: string
    stop: string
    later: string
  }
  repository: {
    checking: string
    outside(folder: string): string
    configured(root: string): string
    offer(root: string): string
    why: string
    create: string
    initialized(root: string): string
    creating: string
    created(path: string): string
    kept(path: string): string
  }
  summary: {
    written(path: string): string
    nothing: string
    skipped(steps: string): string
    indexed(names: string): string
    left(names: string): string
    notIndexed(names: string): string
    created(root: string, files: string): string
    now: string
    watch: string
    review: string
    home: string
  }
}

export interface ConfigMessages {
  create(path: string): string
  save(path: string): string
  unset: string
  publish: { on: string; off: string }
  planning: string
  writing: string
  reformatted: string
  keys: { save: string; cancel: string; again: string }
  invalidConfig(message: string): string
  invalidResult(message: string): string
  ollamaWithoutModel: string
  lastWatchedRepo(repo: string, settings: string): string
  notWatched(repo: string): string
  unreadable(message: string): string
  failed(message: string): string
  changed: string
}

export interface IndexingMessages {
  waiting: string
  fetching: string
  stopping: string
  progress(done: number, total: number): string
  indexed(files: number): string
  cancelled(done: number, total: number): string
  notStarted: string
  noToken: string
  index: string
  again: string
  stop: string
}

export interface GraphMessages {
  amount(value: number): string
  count(total: number): string
  indexed(count: number): string
  columns: {
    repo: string
    state: string
    commit: string
    files: string
    symbols: string
    size: string
    linked: string
  }
  states: Readonly<Record<RepositoryIndexState['state'], string>>
  none: string
  noneHint: string
  detail: {
    index: string
    state: string
    commit: string
    took: string
    files: string
    languages: string
    symbols: string
    links: string
    leftOut: string
    file: string
    indexedAt(relative: string, absolute: string): string
    defaultBranch: string
    filesValue(indexed: number, leftOut: number): string
    linksValue(counts: {
      imports: number
      exports: number
      calls: number
      references: number
      parseErrors: number
    }): string
    nothing: string
    other(files: number): string
    noExtension: string
    missing: string
    empty: string
    otherVersion(found: IndexVersion, expected: IndexVersion): string
    unreadable: string
  }
  languages: Readonly<Record<IndexLanguage, string>>
  symbols: Readonly<Record<IndexSymbolKind, (count: number) => string>>
  leftOut: Readonly<Record<LeftOutGroup['reason'], (count: number) => string>>
  connections: ConnectionMessages
  explore: ExploreMessages
}

export interface ExploreMessages {
  field: string
  search: string
  run: string
  cancel: string
  searching(name: string): string
  cannotExplore(repo: string, why: string): string
  notFound(name: string, repo: string, commit: string): string
  notFoundHint: string
  definitions(count: number, name: string): string
  more(count: number): string
  crosses(names: string): string
  callers: string
  dependencies: string
  loading: string
  none: string
  capped: string
  inferred: string
  observed(pullRequest: number | undefined): string
  kinds: Readonly<Record<IndexSymbolKind, string>>
  keys: { explore: string; expand: string; collapse: string }
}

export interface ConnectionMessages {
  title: string
  none: string
  declareHint: string
  sourceNotIndexed(why: string): string
  configError(message: string): string
  linked: string
  noLink: string
  notIndexed(why: string): string
  unknown: string
  publishes(owner: string, names: string, ecosystem: string, user: string, count: number): string
  why: {
    'no-index': string
    empty: string
    'other-version'(phadaVersion: string | null): string
    unreadable(error: string): string
    'no-mirror': string
    'mirror-unreadable'(error: string): string
  }
  ecosystems: Readonly<Record<PackageRef['ecosystem'], string>>
  indexRelated: string
}

type RequestSource = QueueJob['requests'][number]['source']
export type QueueRowKind = 'running' | 'waiting' | 'queued' | 'skipped' | 'failed'

export interface QueueMessages {
  runningHere: string
  runningElsewhere(pid: number): string
  starting: string
  stopping: string
  stopped: string
  lastCycle(when: string): string
  next(when: string): string
  startHere: string
  notConfigured: string
  setUp(file: string): string
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
  watch: {
    start: string
    stop: string
    log: string
    stopQuestion: string
    stopConfirm: string
    keepRunning: string
    elsewhere(pid: number): string
    startFailed(reason: string): string
    quitQuestion: string
  }
  log: WatchLogMessages
}

export interface WatchLogMessages {
  title: string
  empty: string
  watchStarted: string
  watchStopping: string
  watchStopped: string
  watchAborted: string
  watchFailed(reason: string): string
  baseline(repo: string, count: number): string
  queued(ref: string, sha: string, after: string): string
  superseded(ref: string, sha: string): string
  started(ref: string, sha: string): string
  waiting(ref: string, sha: string, until: string, pending: string): string
  ciFailing(ref: string, sha: string, names: string): string
  ciCleared(ref: string, sha: string): string
  published(ref: string, url: string): string
  notPublished(ref: string): string
  moved(ref: string, sha: string): string
  closed(ref: string): string
  dryRun(ref: string): string
  publishFailed(ref: string, reason: string): string
  nothingToReview(ref: string): string
  skipped(ref: string, reason: string): string
  retry(ref: string, reason: string, at: string): string
  paused(until: string, reason: string): string
  failed(ref: string, reason: string): string
  indexed(repo: string, sha: string): string
  indexPartial(repo: string): string
  feedback(ref: string, comments: number): string
  warning(message: string): string
  limited(count: number, until: string): string
  refused(source: string, ref: string, reason: string): string
}

export type ReviewSource = ListedRun['source'] | NonNullable<ListedRun['requestSource']>

export interface ReviewsMessages {
  count(total: number): string
  latest(shown: number): string
  filter: string
  newReview: string
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
  claimVerdicts: Readonly<Record<string, string>>
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
    claims(count: number): string
    findings(count: number): string
    worthChecking(count: number): string
    debt(count: number): string
    debtMark: string
    closeToCutMark: string
    feedback(count: number): string
    nothingPosted: string
    wouldResolve(count: number): string
    wouldSkip(reason: string): string
    skipReasons: Readonly<Record<string, string>>
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
  pick: RepositoryPickMessages
  edit: {
    watch: string
    unwatch: string
    publishOn: string
    publishOff: string
    add: string
    review: string
    config: string
    rules: string
    addIntro: string
    noToken: string
    editorFailed(code: number): string
  }
}

export interface RepositoryPickMessages {
  listing: string
  count(shown: number, total: number, marked: number): string
  noMatch(text: string): string
  none: string
  failed(message: string): string
  typeHint: string
  filter: string
  field: string
  invalid(value: string): string
  private: string
  fork: string
  notListed: string
  keys: { space: string; mark: string; filter: string; add: string }
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
  notReady: string
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
  logIn(name: string): string
  loginNotCompleted(name: string): string
  change: string
  changeIntro: string
  languageKey: string
  language(name: string): string
  pick: {
    choose: string
    modelFor(name: string): string
    cliDefault: string
    typeModel: string
    modelField: string
    installed: string
    current: string
    suggested(size: string): string
    pull: string
    serveHint: string
    pulling(model: string): string
    progress(done: string, total: string, percent: number): string
    pulled(model: string): string
    cancelled(model: string): string
    failed(model: string, message: string): string
    ended(model: string): string
    stopped: string
    cancelPull: string
  }
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

export type RuleStatus = 'applied' | 'disabled' | 'out-of-scope' | 'listed'
export type DocStatus = 'included' | 'truncated' | 'omitted' | 'listed'
export type DocReason =
  'budget' | 'binary' | 'not-found' | 'unreadable' | 'out-of-scope' | 'manual' | 'excluded'

export interface RulesMessages {
  pick: string
  none: string
  noneHint: string
  pullKey: string
  pullField: string
  invalidNumber(text: string): string
  noToken: string
  lens: string
  builtIn: string
  prompt(file: string, mode: string): string
  promptModes: { append: string; replace: string }
  skills(names: string): string
  native: string
  setBy(where: string): string
  layers: { global: string; repository: string; phada(file: string): string }
  localOnly: string
  userRules(count: number): string
  noUserRules: string
  phadaFolder: string
  atBranch(ref: string): string
  empty: string
  nothingLoaded: string
  initHint: string
  configFiles(count: number): string
  configOrigins: { repository: string; user: string }
  rules(count: number): string
  docs(count: number): string
  ignore: string
  ruleStatuses: Readonly<Record<RuleStatus, string>>
  docStatuses: Readonly<Record<DocStatus, string>>
  docReasons: Readonly<Record<DocReason, string>>
  appliesTo(scope: string): string
  commits(head: string, base: string): string
  loadedRules: string
  promptHeading: string
  computed: string
  pass(index: number, skill: string): string
  builtInOrigin: string
  skipped(reason: string): string
  nativeMessage(message: string): string
  dataBlocks: string
  instructions: string
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
