import type { ConfigLayer } from '../config/types.js'
import { DEFAULT_IGNORE, matcher } from '../context/ignore.js'
import { loadContext } from '../context/load-context.js'
import type { ContextReport, ContextSources, LoadedContext } from '../context/types.js'
import type { PullRequest } from '../github/pull-request.js'
import { changedLines, computeImpact } from '../graph/impact.js'
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
import { DEPENDENCY_FOLDERS, indexCommit } from './index-repository.js'

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
  events: PullRequestReviewEvents
}

export interface PullRequestReview {
  outcome: ReviewOutcome
  context: LoadedContext
  language?: string
  investigation: InvestigationReport
  impact: ImpactReport
  impactText?: string
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
  try {
    if (investigate && loaded.diff.trim() !== '') {
      let opened: { mirror: GitMirror; sha: string; checkout: Checkout } | undefined
      try {
        const mirror = await deps.openMirror()
        const sha = await mirror.fetch(pullRequest.headSha, keepAs)
        opened = { mirror, sha, checkout: mirror.checkout(sha, { deepenAs: keepAs }) }
      } catch (error) {
        if (!(error instanceof CheckoutUnavailableError)) throw error
        unavailable = error.message
        deps.events.warning(`${error.message}: reviewing without investigation.`)
      }
      if (opened !== undefined) {
        investigation = createInvestigation(opened.checkout)
        head = await openHeadGraph(pullRequest, loaded, opened, deps)
        if (head.graph !== undefined) {
          impact = await computeImpact(head.graph, changedLines(loaded.diff))
          investigation = createInvestigation(opened.checkout, { graph: head.graph })
        }
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
      },
      {
        provider: watch(provider, 'review'),
        verifier: watch(provider, 'verify'),
        ...(investigation === undefined ? {} : { tools: investigation.tools }),
      },
    )

    const reviewed = outcome.status === 'reviewed' ? outcome.result : undefined
    const learned = learn(head, investigation, reviewed, pullRequest)
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
    }
  } finally {
    await investigation?.close()
    head.store?.close()
    head.observed?.close()
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
    let observed: ObservedStore | undefined
    try {
      observed = await deps.openObservedStore()
    } catch (error) {
      if (!(error instanceof IndexStoreError)) throw error
      deps.events.warning(`${error.message}: reviewing without what earlier reviews learned.`)
    }
    const graph = await openRepositoryGraph({
      reader: store.reader(sha),
      readText: (path) => checkout.readText(path),
      observed: observed?.all() ?? [],
    })
    const stale = graph.staleObserved()
    if (stale.length > 0) observed?.remove(stale)
    return {
      graph,
      store,
      ...(observed === undefined ? {} : { observed }),
      index: { files: result.files, extracted: result.extracted, durationMs: result.durationMs },
    }
  } catch (error) {
    if (!(error instanceof IndexStoreError) && !(error instanceof CheckoutUnavailableError)) {
      store?.close()
      throw error
    }
    store?.close()
    deps.events.warning(`${error.message}: reviewing without the repository graph.`)
    return { reason: error.message }
  }
}

function learn(
  head: HeadGraph,
  investigation: Investigation | undefined,
  reviewed: Extract<ReviewOutcome, { status: 'reviewed' }>['result'] | undefined,
  pullRequest: PullRequest,
): ObservedEdge[] {
  if (head.graph === undefined || head.observed === undefined || investigation === undefined)
    return []
  if (reviewed === undefined) return []
  const learned = learnObservedEdges({
    graph: head.graph,
    findings: reviewed.findings,
    verified: reviewed.verification !== undefined,
    readPaths: new Set(investigation.log.records.flatMap((record) => record.paths)),
    pullRequest: pullRequest.number,
    commit: head.graph.commit,
    known: head.observed.all(),
  })
  head.observed.add(learned)
  return learned
}
