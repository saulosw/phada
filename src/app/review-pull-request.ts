import type { ConfigLayer } from '../config/types.js'
import { loadContext } from '../context/load-context.js'
import type { ContextReport, ContextSources, LoadedContext } from '../context/types.js'
import type { PullRequest } from '../github/pull-request.js'
import { changedLines, computeImpact } from '../graph/impact.js'
import type { ChangedLines } from '../graph/impact.js'
import { linkGraphs } from '../graph/linked-graph.js'
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
import { errorMessage } from './error-message.js'
import { indexForReview } from './index-repository.js'
import { checkoutPackages, openRelatedRepositories } from './related-repositories.js'
import type { OpenedRelated, RelatedDeps } from './related-repositories.js'
import {
  buildRelatedReport,
  rankOpened,
  reachesDropped,
  relatedSummaries,
} from './related-report.js'
import type { RankedRelated, RelatedReport } from './related-report.js'
import type { SkippedRepository } from './select-related.js'

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
  relatedReady(report: RelatedReport): void
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
          try {
            const related = await openRelated(
              pullRequest,
              loaded,
              fetched,
              deps.related,
              head.graph !== undefined,
            )
            opened = related.opened
            skipped = related.skipped
            relatedStatus = 'used'
          } catch (error) {
            relatedReason = errorMessage(error)
            deps.events.warning(`${relatedReason}: reviewing without related repositories.`)
          }
        }
        const changed = changedLines(loaded.diff)
        let graph: RepositoryGraph | undefined
        if (head.graph !== undefined) {
          try {
            const linked = await linkAndRank(head.graph, opened, changed)
            graph = linked.graph
            impact = linked.impact
            kept = linked.kept
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
    const graphTools = head.graph !== undefined
    const relatedReport = buildRelatedReport({
      status: relatedStatus,
      ...(relatedStatus === 'unavailable'
        ? {
            reason:
              relatedReason ??
              (loaded.diff.trim() === '' ? 'nothing to review' : 'investigation did not run'),
          }
        : {}),
      opened,
      kept,
      skipped,
      graphTools,
    })
    deps.events.relatedReady(relatedReport)

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
        ...(kept.length === 0 ? {} : { related: relatedSummaries(kept, graphTools) }),
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

async function linkAndRank(
  reviewed: RepositoryGraph,
  opened: readonly OpenedRelated[],
  changed: readonly ChangedLines[],
): Promise<{ graph: RepositoryGraph; impact: DiffImpact; kept: RankedRelated[] }> {
  let graph = linkGraphs(reviewed, linkedOf(opened))
  let impact = await computeImpact(graph, changed)
  let kept = rankOpened(opened, impact)
  if (kept.length < opened.length && reachesDropped(opened, kept, impact)) {
    const items = kept.map(({ item }) => item)
    graph = linkGraphs(reviewed, linkedOf(items))
    impact = await computeImpact(graph, changed)
    kept = rankOpened(items, impact)
  }
  return { graph, impact, kept }
}

async function openRelated(
  pullRequest: PullRequest,
  loaded: LoadedContext,
  fetched: { mirror: GitMirror; sha: string; checkout: Checkout },
  deps: RelatedDeps,
  index: boolean,
): Promise<{ opened: OpenedRelated[]; skipped: SkippedRepository[] }> {
  const files = await fetched.mirror.listFiles(fetched.sha)
  const reviewedPackages = await checkoutPackages(files, fetched.checkout)
  return openRelatedRepositories(
    {
      declared: loaded.repos,
      reviewed: pullRequest.repo,
      pullRequestPrivate: pullRequest.private,
      privateOnPublic: loaded.privateOnPublic,
      reviewedPackages,
      index,
    },
    deps,
  )
}

function linkedOf(opened: readonly OpenedRelated[]) {
  return opened.flatMap((item) =>
    item.graph === undefined ? [] : [{ repo: item.repo, graph: item.graph, link: item.link }],
  )
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
    const result = await indexForReview(
      { sha, ref: `refs/phada/pull/${pullRequest.number}`, files, ignore: loaded.ignore, deadline },
      {
        mirror,
        store,
        extractor: deps.extractor,
        now: deps.now,
        events: { extracting: deps.events.indexing, extracted: deps.events.indexed },
      },
    )
    if (!result.complete) {
      deps.events.warning(
        `Index of ${pullRequest.repo} is not ready (${result.progress}): reviewing without the repository graph. Run phada index ${pullRequest.repo}, or the next review continues it.`,
      )
      store.close()
      return { reason: `index of ${pullRequest.repo} is not ready (${result.progress})` }
    }
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

function learn(
  head: HeadGraph,
  investigation: Investigation | undefined,
  reviewed: Extract<ReviewOutcome, { status: 'reviewed' }>['result'] | undefined,
  pullRequest: PullRequest,
  events: PullRequestReviewEvents,
  relatedRepos: ReadonlySet<string>,
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
