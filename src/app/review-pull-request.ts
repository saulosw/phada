import type { ConfigLayer } from '../config/types.js'
import { DEFAULT_IGNORE, matcher } from '../context/ignore.js'
import { loadContext } from '../context/load-context.js'
import type { ContextReport, ContextSources, LoadedContext } from '../context/types.js'
import type { PullRequest } from '../github/pull-request.js'
import { changedLines, computeImpact } from '../graph/impact.js'
import { linkGraphs } from '../graph/linked-graph.js'
import { readPackages } from '../graph/packages.js'
import { learnObservedEdges } from '../graph/observe.js'
import { buildImpactReport } from '../graph/report.js'
import type { ImpactIndex, ImpactReport } from '../graph/report.js'
import { openRepositoryGraph } from '../graph/repository-graph.js'
import type { RepositoryGraph } from '../graph/types.js'
import { createInvestigation } from '../investigation/create-investigation.js'
import type { Investigation } from '../investigation/create-investigation.js'
import { buildInvestigationReport } from '../investigation/tools/report.js'
import type { InvestigationReport } from '../investigation/tools/report.js'
import type { ReviewPass } from '../investigation/tools/tool-log.js'
import type { ReviewProvider } from '../providers/types.js'
import type { Extractor } from '../repo-map/extract.js'
import type { Checkout } from '../repository/checkout.js'
import { CheckoutUnavailableError } from '../repository/git-checkout.js'
import type { GitMirror } from '../repository/git-mirror.js'
import { renderImpact } from '../review/impact-text.js'
import { runReview } from '../review/run-review.js'
import type { DiffImpact, ReviewOutcome } from '../review/types.js'
import { IndexStoreError } from '../store/index-store.js'
import type { IndexStore } from '../store/index-store.js'
import type { ObservedEdge, ObservedStore } from '../store/observed-store.js'
import { DEPENDENCY_FOLDERS, indexCommit, KEEP_COMMITS } from './index-repository.js'
import { openRelatedRepositories } from './related-repositories.js'
import type { OpenedRelated, RelatedDeps } from './related-repositories.js'
import type { RelatedEntry, RelatedReport } from './related-report.js'
import { rankRelated } from './select-related.js'
import type { SkippedRepository } from './select-related.js'
import type { RelatedState, RelatedSummary } from '../review/types.js'

export const REVIEW_INDEX_BUDGET_MS = 60_000

export interface ReviewOptions {
  language?: string
  minConfidence?: number
  verify?: boolean
  investigate?: boolean
}

export interface PullRequestReviewInput {
  pullRequest: PullRequest
  userLayers: readonly ConfigLayer[]
  userMcpServers: readonly string[]
  options: ReviewOptions
}

export interface PullRequestReviewEvents {
  contextLoaded(report: ContextReport): void
  warning(message: string): void
  indexing(total: number): void
  indexed(done: number, total: number): void
  impactReady(report: ImpactReport): void
  relatedReady?(report: RelatedReport): void
}

export interface PullRequestReviewDeps {
  contextSources: ContextSources
  openMirror: () => Promise<GitMirror>
  openIndexStore: () => Promise<IndexStore>
  openObservedStore: () => Promise<ObservedStore>
  extractor: Extractor
  now: () => number
  createProvider: (userMcpServers: readonly string[]) => ReviewProvider
  watchProvider?: (provider: ReviewProvider, pass: ReviewPass) => ReviewProvider
  related?: RelatedDeps
  events: PullRequestReviewEvents
}

export interface PullRequestReview {
  outcome: ReviewOutcome
  context: LoadedContext
  language?: string
  investigation: InvestigationReport
  impact: ImpactReport
  impactText?: string
  related: RelatedReport
}

interface RankedRelated {
  item: OpenedRelated
  state: RelatedState
  count: number
  order: number
}

interface HeadGraph {
  graph?: RepositoryGraph
  store?: IndexStore
  observed?: ObservedStore
  index?: ImpactIndex
  reason?: string
}

export async function reviewPullRequest(
  input: PullRequestReviewInput,
  deps: PullRequestReviewDeps,
): Promise<PullRequestReview> {
  const { pullRequest, options } = input
  const loaded = await loadContext({
    diff: pullRequest.diff,
    baseSha: pullRequest.baseSha,
    userLayers: input.userLayers,
    sources: deps.contextSources,
  })
  deps.events.contextLoaded(loaded.report)
  const language = options.language ?? loaded.options.language
  const investigate = options.investigate ?? loaded.options.investigate ?? true
  const keepAs = `refs/phada/pull/${pullRequest.number}`

  let investigation: Investigation | undefined
  let unavailable: string | undefined
  let head: HeadGraph = {}
  let impact: DiffImpact | undefined
  let impactReport: ImpactReport
  let opened: OpenedRelated[] = []
  let kept: RankedRelated[] = []
  let skipped: SkippedRepository[] = []
  let relatedStatus: RelatedReport['status'] =
    loaded.repos.length === 0 ? 'none' : investigate ? 'unavailable' : 'off'
  let relatedReason: string | undefined
  try {
    if (investigate && loaded.diff.trim() !== '') {
      let fetched: { mirror: GitMirror; sha: string; checkout: Checkout } | undefined
      try {
        const mirror = await deps.openMirror()
        const sha = await mirror.fetch(pullRequest.headSha, keepAs)
        fetched = { mirror, sha, checkout: mirror.checkout(sha, { deepenAs: keepAs }) }
      } catch (error) {
        if (!(error instanceof CheckoutUnavailableError)) throw error
        unavailable = error.message
        relatedReason = error.message
        deps.events.warning(`${error.message}: reviewing without investigation.`)
      }
      if (fetched !== undefined) {
        head = await openHeadGraph(pullRequest, loaded, fetched, deps)
        if (loaded.repos.length > 0 && deps.related !== undefined) {
          const related = await openRelated(pullRequest, loaded, fetched, deps.related)
          opened = related.opened
          skipped = related.skipped
          relatedStatus = 'used'
        }
        const changed = changedLines(loaded.diff)
        let graph: RepositoryGraph | undefined
        if (head.graph !== undefined) {
          try {
            graph = linkGraphs(head.graph, linkedOf(opened))
            impact = await computeImpact(graph, changed)
            kept = rankOpened(opened, impact)
            if (kept.length < opened.length && dropsRelation(opened, kept, impact)) {
              graph = linkGraphs(head.graph, linkedOf(kept.map(({ item }) => item)))
              impact = await computeImpact(graph, changed)
              kept = rankOpened(
                kept.map(({ item }) => item),
                impact,
              )
            }
          } catch (error) {
            const message = errorMessage(error)
            deps.events.warning(graphFailure(message))
            head = { ...head, reason: message }
            delete head.graph
            graph = undefined
            impact = undefined
          }
        }
        if (graph === undefined) kept = rankOpened(opened, undefined)
        investigation = createInvestigation(fetched.checkout, {
          ...(graph === undefined ? {} : { graph }),
          related: kept.map(({ item }) => ({
            repo: item.repo,
            checkout: item.checkout,
            ...(item.graph === undefined ? {} : { graph: item.graph }),
          })),
        })
      }
    }
    impactReport = buildImpactReport({
      status: impact !== undefined ? 'used' : investigate ? 'unavailable' : 'off',
      ...(impact === undefined && investigate
        ? { reason: head.reason ?? unavailable ?? 'nothing to review' }
        : {}),
      ...(head.index === undefined ? {} : { index: head.index }),
      ...(impact === undefined ? {} : { impact, shown: renderImpact(impact).shown }),
    })
    deps.events.impactReady(impactReport)
    const keptRepos = new Set(kept.map(({ item }) => item.repo))
    const relatedReport: RelatedReport = {
      status: relatedStatus,
      ...(relatedStatus === 'unavailable'
        ? { reason: relatedReason ?? 'investigation did not run' }
        : {}),
      repositories: [
        ...kept.map(entryOf),
        ...opened
          .filter((item) => !keptRepos.has(item.repo))
          .map((item): RelatedEntry => skippedEntry({ ...item, reason: 'limit' })),
        ...skipped.map(skippedEntry),
      ],
    }
    deps.events.relatedReady?.(relatedReport)

    const servers = investigation === undefined ? [] : input.userMcpServers
    if (servers.length > 0 && !pullRequest.private) {
      deps.events.warning(
        `${pullRequest.repo} is public: what the AI reads from ${servers.join(', ')} may end up in the published review.`,
      )
    }

    const provider = deps.createProvider(servers)
    const watch = deps.watchProvider ?? ((watched: ReviewProvider) => watched)
    const outcome = await runReview(
      {
        pullRequest: { ...pullRequest, diff: loaded.diff },
        language,
        minConfidence: options.minConfidence ?? loaded.options.minConfidence,
        verify: options.verify ?? loaded.options.verify ?? true,
        context: loaded.context,
        ...(impact === undefined ? {} : { impact }),
        ...(kept.length === 0 ? {} : { related: kept.map(summaryOf) }),
      },
      {
        provider: watch(provider, 'review'),
        verifier: watch(provider, 'verify'),
        ...(investigation === undefined ? {} : { tools: investigation.tools }),
      },
    )

    const reviewed = outcome.status === 'reviewed' ? outcome.result : undefined
    const learned = learn(head, investigation, reviewed, pullRequest, deps.events, keptRepos)
    const report = buildInvestigationReport({
      status: investigation !== undefined ? 'used' : investigate ? 'unavailable' : 'off',
      ...(unavailable === undefined ? {} : { reason: unavailable }),
      ...(investigation === undefined ? {} : { log: investigation.log }),
      findings: reviewed?.findings ?? [],
      external: reviewed?.externalCalls ?? [],
    })
    return {
      outcome,
      context: loaded,
      ...(language === undefined ? {} : { language }),
      investigation: report,
      ...(impact === undefined ? {} : { impactText: renderImpact(impact).text }),
      impact:
        learned.length === 0
          ? impactReport
          : { ...impactReport, learned: buildImpactReport({ status: 'used', learned }).learned },
      related: relatedReport,
    }
  } finally {
    await investigation?.close()
    for (const item of opened) await item.close()
    head.store?.close()
    head.observed?.close()
  }
}

async function openRelated(
  pullRequest: PullRequest,
  loaded: LoadedContext,
  fetched: { mirror: GitMirror; sha: string; checkout: Checkout },
  deps: RelatedDeps,
): Promise<{ opened: OpenedRelated[]; skipped: SkippedRepository[] }> {
  const files = await fetched.mirror.listFiles(fetched.sha)
  const reviewedPackages = await readPackages(new Set(files.map((file) => file.path)), (path) =>
    fetched.checkout.readText(path),
  )
  return openRelatedRepositories(
    {
      declared: loaded.repos,
      reviewed: pullRequest.repo,
      pullRequestPrivate: pullRequest.private,
      privateOnPublic: loaded.privateOnPublic,
      reviewedPackages,
    },
    deps,
  )
}

function linkedOf(opened: readonly OpenedRelated[]) {
  return opened.flatMap((item) =>
    item.graph === undefined ? [] : [{ repo: item.repo, graph: item.graph, link: item.link }],
  )
}

function rankOpened(
  opened: readonly OpenedRelated[],
  impact: DiffImpact | undefined,
): RankedRelated[] {
  const ranked = opened.map((item): RankedRelated => {
    const consumers = (impact?.symbols ?? []).reduce(
      (sum, symbol) => sum + symbol.sites.filter((site) => site.repo === item.repo).length,
      0,
    )
    const uses = (impact?.symbols ?? []).reduce(
      (sum, symbol) =>
        sum + symbol.dependencies.filter((dependency) => dependency.repo === item.repo).length,
      0,
    )
    const linked = item.link.consumedByRelated.length > 0 || item.link.consumedByReviewed.length > 0
    const state: RelatedState =
      consumers > 0 ? 'consumers' : uses > 0 ? 'uses' : linked ? 'linked' : 'unlinked'
    return { item, state, count: consumers > 0 ? consumers : uses, order: item.order }
  })
  return rankRelated(ranked).kept
}

function dropsRelation(
  opened: readonly OpenedRelated[],
  kept: readonly RankedRelated[],
  impact: DiffImpact,
): boolean {
  const keptRepos = new Set(kept.map(({ item }) => item.repo))
  const dropped = new Set(
    opened.filter((item) => !keptRepos.has(item.repo)).map((item) => item.repo),
  )
  return impact.symbols.some(
    (symbol) =>
      symbol.sites.some((site) => site.repo !== undefined && dropped.has(site.repo)) ||
      symbol.dependencies.some(
        (dependency) => dependency.repo !== undefined && dropped.has(dependency.repo),
      ),
  )
}

function packagesOf(item: OpenedRelated): string[] {
  return [...item.link.consumedByRelated, ...item.link.consumedByReviewed].map((ref) => ref.name)
}

function entryOf({ item, state, count }: RankedRelated): RelatedEntry {
  return {
    repo: item.repo,
    origin: item.origin,
    ...(item.description === undefined ? {} : { description: item.description }),
    commit: item.commit,
    state,
    ...(state === 'consumers' || state === 'uses' ? { count } : {}),
    packages: packagesOf(item),
    graph: item.graph !== undefined,
  }
}

function skippedEntry(item: Pick<SkippedRepository, 'repo' | 'origin' | 'reason'>): RelatedEntry {
  return {
    repo: item.repo,
    origin: item.origin,
    state: 'skipped',
    packages: [],
    graph: false,
    reason: item.reason,
  }
}

function summaryOf({ item, state, count }: RankedRelated): RelatedSummary {
  return {
    repo: item.repo,
    commit: item.commit,
    state,
    ...(state === 'consumers' || state === 'uses' ? { count } : {}),
    ...(item.description === undefined ? {} : { description: item.description }),
    graph: item.graph !== undefined,
  }
}

async function openHeadGraph(
  pullRequest: PullRequest,
  loaded: LoadedContext,
  opened: { mirror: GitMirror; sha: string; checkout: Checkout },
  deps: PullRequestReviewDeps,
): Promise<HeadGraph> {
  const { mirror, sha, checkout } = opened
  let store: IndexStore | undefined
  let observed: ObservedStore | undefined
  try {
    const files = await mirror.listFiles(sha)
    store = await deps.openIndexStore()
    const deadline = deps.now() + REVIEW_INDEX_BUDGET_MS
    const result = await indexCommit(
      {
        sha,
        ref: `refs/phada/pull/${pullRequest.number}`,
        files,
        ignore: matcher([...DEFAULT_IGNORE, ...DEPENDENCY_FOLDERS, ...loaded.ignore]),
        deadline,
      },
      {
        mirror,
        store,
        extractor: deps.extractor,
        now: deps.now,
        events: { extracting: deps.events.indexing, extracted: deps.events.indexed },
      },
    )
    if (!result.complete) {
      const progress = `${result.extracted.toLocaleString('en-US')} of ${result.total.toLocaleString('en-US')} files`
      deps.events.warning(
        `Index of ${pullRequest.repo} is not ready (${progress}): reviewing without the repository graph. Run phada index ${pullRequest.repo}, or the next review continues it.`,
      )
      store.close()
      return { reason: `index of ${pullRequest.repo} is not ready (${progress})` }
    }
    store.prune(KEEP_COMMITS)
    try {
      observed = await deps.openObservedStore()
      if (observed.rebuilt) {
        deps.events.warning(
          `What earlier reviews of ${pullRequest.repo} learned could not be read: starting over.`,
        )
      }
    } catch (error) {
      if (!(error instanceof IndexStoreError)) throw error
      deps.events.warning(`${error.message}: reviewing without what earlier reviews learned.`)
    }
    const graph = await openRepositoryGraph({
      reader: store.reader(sha),
      readText: (path) => checkout.readText(path),
      observed: observed?.all() ?? [],
    })
    return {
      graph,
      store,
      ...(observed === undefined ? {} : { observed }),
      index: { files: result.files, extracted: result.extracted, durationMs: result.durationMs },
    }
  } catch (error) {
    store?.close()
    observed?.close()
    const message = errorMessage(error)
    deps.events.warning(
      error instanceof IndexStoreError || error instanceof CheckoutUnavailableError
        ? `${message}: reviewing without the repository graph.`
        : graphFailure(message),
    )
    return { reason: message }
  }
}

function graphFailure(message: string): string {
  return `Could not use the repository graph (${message}): reviewing without it.`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function learn(
  head: HeadGraph,
  investigation: Investigation | undefined,
  reviewed: Extract<ReviewOutcome, { status: 'reviewed' }>['result'] | undefined,
  pullRequest: PullRequest,
  events: PullRequestReviewEvents,
  relatedRepos: ReadonlySet<string> = new Set(),
): ObservedEdge[] {
  if (head.graph === undefined || head.observed === undefined || investigation === undefined)
    return []
  if (reviewed === undefined) return []
  try {
    const learned = learnObservedEdges({
      graph: head.graph,
      findings: reviewed.findings,
      verified: reviewed.verification !== undefined,
      readPaths: new Set(
        investigation.log.records
          .flatMap((record) => record.touched)
          .filter((path) => ![...relatedRepos].some((repo) => path.startsWith(`${repo}:`))),
      ),
      pullRequest: pullRequest.number,
      commit: head.graph.commit,
      known: head.observed.all(),
    })
    head.observed.add(learned)
    return learned
  } catch (error) {
    events.warning(`Could not save what this review learned (${errorMessage(error)}).`)
    return []
  }
}
