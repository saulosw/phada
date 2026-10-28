import type { ResolvedMcp } from '../config/mcp-servers.js'
import type { ConfigLayer } from '../config/types.js'
import { loadContext } from '../context/load-context.js'
import { splitDiff } from '../context/split-diff.js'
import type { Ci, ContextReport, ContextSources, LoadedContext } from '../context/types.js'
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
import type { Toolbox } from '../investigation/toolbox.js'
import type { ReviewPass } from '../investigation/tools/tool-log.js'
import type { ReviewProvider } from '../providers/types.js'
import type { Extractor } from '../repo-map/extract.js'
import type { Checkout } from '../repository/checkout.js'
import { CheckoutUnavailableError } from '../repository/git-checkout.js'
import type { GitMirror } from '../repository/git-mirror.js'
import { renderImpact } from '../review/impact-text.js'
import { runReview } from '../review/run-review.js'
import { recheckThreads } from '../review/recheck-threads.js'
import type { Conversation } from '../publish/types.js'
import type { DiffImpact, RecheckReport, RecheckThread, ReviewOutcome } from '../review/types.js'
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
import { connectMcp } from '../investigation/mcp/mcp-client.js'
import type { McpServerReport } from '../investigation/tools/report.js'
import { openNativeRunner } from './native-skill.js'
import { fromOutsideAuthor, hasMcp, mcpOff, openMcp } from './open-mcp.js'
import type { ConnectMcp, OpenedMcp } from './open-mcp.js'
import type { NativeRunner, NativeRunnerDeps, NativeRunnerInput } from './native-skill.js'
import { buildPasses } from './review-passes.js'
import { stopIfCancelled } from './review-cancelled.js'
import type { PassPlan, SkillCatalog } from './review-passes.js'
import type { ReadGitHub } from '../gh-facade/types.js'
import type { SkippedRepository } from './select-related.js'

export const REVIEW_INDEX_BUDGET_MS = 60_000

export interface ReviewOptions {
  language?: string
  minConfidence?: number
  verify?: boolean
  investigate?: boolean
  resolveThreads?: boolean
  conversation?: boolean
  ci?: boolean
  skills?: string[]
}

export interface PullRequestReviewInput {
  pullRequest: PullRequest
  userLayers: readonly ConfigLayer[]
  mcp: ResolvedMcp
  options: ReviewOptions
  loaded?: LoadedContext
  recheck?: readonly RecheckThread[]
  viewer?: string
  conversation?: Conversation
  ci?: Ci
  signal?: AbortSignal
}

export interface PullRequestReviewEvents {
  contextLoaded(report: ContextReport): void
  warning(message: string): void
  indexing(total: number): void
  indexed(done: number, total: number): void
  impactReady(report: ImpactReport): void
  relatedReady(report: RelatedReport): void
  passesPlanned?(plan: PassPlan[]): void
  passStarted?(skill: string, index: number, total: number): void
}

export interface PullRequestReviewDeps {
  contextSources: ContextSources
  openMirror: () => Promise<GitMirror>
  openIndexStore: () => Promise<IndexStore>
  openObservedStore: () => Promise<ObservedStore>
  extractor: Extractor
  now: () => number
  createProvider: (useNames: boolean) => ReviewProvider
  connectMcp?: ConnectMcp
  watchProvider?: (provider: ReviewProvider, pass: ReviewPass) => ReviewProvider
  related?: RelatedDeps
  skills: SkillCatalog
  runsSkills?: boolean
  readGitHub?: ReadGitHub
  env?: NodeJS.ProcessEnv
  resolveDir?: (path: string) => Promise<string | undefined>
  openNativeRunner?: (input: NativeRunnerInput, deps: NativeRunnerDeps) => Promise<NativeRunner>
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
  recheck?: RecheckReport
  passes?: PassPlan[]
  conversation?: Conversation
  ci?: Ci
}

export async function loadPullRequestContext(
  input: Pick<PullRequestReviewInput, 'pullRequest' | 'userLayers'>,
  deps: Pick<PullRequestReviewDeps, 'contextSources' | 'events'>,
): Promise<LoadedContext> {
  const loaded = await loadContext({
    diff: input.pullRequest.diff,
    baseSha: input.pullRequest.baseSha,
    userLayers: input.userLayers,
    sources: deps.contextSources,
  })
  deps.events.contextLoaded(loaded.report)
  return loaded
}

interface HeadGraph {
  graph?: RepositoryGraph
  store?: IndexStore
  observed?: ObservedStore
  index?: ImpactIndex
  reason?: string
}

async function noGitHubReads(): Promise<never> {
  throw new Error('GitHub reads are not available in this review.')
}

export async function reviewPullRequest(
  input: PullRequestReviewInput,
  deps: PullRequestReviewDeps,
): Promise<PullRequestReview> {
  const { pullRequest, options, signal } = input
  const stop = () => stopIfCancelled(signal)
  stop()
  const loaded = input.loaded ?? (await loadPullRequestContext(input, deps))
  stop()
  const language = options.language ?? loaded.options.language
  const investigate = options.investigate ?? loaded.options.investigate ?? true
  const keepAs = `refs/phada/pull/${pullRequest.number}`
  const planned = await buildPasses({
    ...(loaded.options.review === undefined ? {} : { review: loaded.options.review }),
    ...(options.skills === undefined ? {} : { cliSkills: options.skills }),
    changedFiles: splitDiff(loaded.diff).sections.map((section) => section.path),
    readRepoFile: (path) => deps.contextSources.readRepoFile(path),
    readLocalFile: (path) => deps.contextSources.readLocalFile(path),
    skills: deps.skills,
    native: deps.runsSkills ?? false,
  })
  stop()
  for (const warning of planned.warnings) deps.events.warning(warning)
  if (planned.passes !== undefined) deps.events.passesPlanned?.(planned.plan)

  let investigation: Investigation | undefined
  let mirror: GitMirror | undefined
  let headCheckout: Checkout | undefined
  let native: NativeRunner | undefined
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
  let mcpOpened: OpenedMcp | undefined
  const outside = hasMcp(input.mcp) && fromOutsideAuthor(pullRequest)
  try {
    if (investigate && loaded.diff.trim() !== '') {
      let fetched: { mirror: GitMirror; sha: string; checkout: Checkout } | undefined
      try {
        const opened = await deps.openMirror()
        const sha = await opened.fetch(
          pullRequest.headSha,
          keepAs,
          signal === undefined ? {} : { signal },
        )
        mirror = opened
        headCheckout = opened.checkout(sha, { deepenAs: keepAs })
        fetched = { mirror: opened, sha, checkout: headCheckout }
      } catch (error) {
        stopIfCancelled(signal, error)
        if (!(error instanceof CheckoutUnavailableError)) throw error
        unavailable = error.message
        relatedReason = error.message
        deps.events.warning(`${error.message}: reviewing without investigation.`)
      }
      stop()
      if (fetched !== undefined) {
        head = await openHeadGraph(pullRequest, loaded, fetched, deps, signal)
        stop()
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
            stopIfCancelled(signal, error)
            relatedReason = errorMessage(error)
            deps.events.warning(`${relatedReason}: reviewing without related repositories.`)
          }
        }
        stop()
        const changed = changedLines(loaded.diff)
        let graph: RepositoryGraph | undefined
        if (head.graph !== undefined) {
          try {
            const linked = await linkAndRank(head.graph, opened, changed)
            graph = linked.graph
            impact = linked.impact
            kept = linked.kept
          } catch (error) {
            stopIfCancelled(signal, error)
            const message = errorMessage(error)
            deps.events.warning(graphFailure(message))
            head = { ...head, reason: message }
            delete head.graph
            graph = undefined
            impact = undefined
          }
        }
        if (graph === undefined) kept = rankOpened(opened, undefined)
        if (outside) {
          deps.events.warning(
            `${pullRequest.repo}#${pullRequest.number} is from an outside author: reviewing without your MCP servers.`,
          )
        } else if (hasMcp(input.mcp)) {
          mcpOpened = await openMcp(
            input.mcp,
            deps.connectMcp ?? ((server) => connectMcp(server, { env: deps.env ?? {} })),
            deps.events.warning,
          )
        }
        investigation = createInvestigation(fetched.checkout, {
          ...(mcpOpened?.investigation === undefined ? {} : { mcp: mcpOpened.investigation }),
          ...(graph === undefined ? {} : { graph }),
          related: kept.map(({ item }) => ({
            repo: item.repo,
            checkout: item.checkout,
            ...(item.graph === undefined ? {} : { graph: item.graph }),
          })),
        })
        stop()
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

    const servers = investigation === undefined ? [] : (mcpOpened?.readFrom ?? [])
    if (servers.length > 0 && !pullRequest.private) {
      deps.events.warning(
        `${pullRequest.repo} is public: what the AI reads from ${servers.join(', ')} may end up in the published review.`,
      )
    }

    const related = kept.length === 0 ? undefined : relatedSummaries(kept, graphTools)
    const conversation =
      input.conversation === undefined || input.conversation.items.length === 0
        ? undefined
        : input.conversation.items
    const ci = input.ci === undefined || input.ci.checks.length === 0 ? undefined : input.ci.checks
    stop()
    const provider = deps.createProvider(
      investigation !== undefined && !outside && input.mcp.names.length > 0,
    )
    const watch = deps.watchProvider ?? ((watched: ReviewProvider) => watched)
    if (planned.nativeSkills.size > 0) {
      native = await (deps.openNativeRunner ?? openNativeRunner)(
        {
          pullRequest,
          diff: loaded.diff,
          review: loaded.options.review ?? {},
          nativeSkills: planned.nativeSkills,
          viewer: input.viewer ?? '',
          ...(conversation === undefined ? {} : { conversation }),
          ...(input.ci === undefined ? {} : { checks: input.ci.entries }),
          ...(ci === undefined ? {} : { ci }),
          ...(impact === undefined ? {} : { impact }),
          ...(related === undefined ? {} : { related }),
          ...(language === undefined ? {} : { language }),
        },
        {
          mirror: mirror ?? (await deps.openMirror()),
          provider: watch(provider, 'review'),
          env: deps.env ?? {},
          readGitHub: deps.readGitHub ?? noGitHubReads,
          resolveDir: deps.resolveDir ?? (async () => undefined),
          tools: () => investigation?.tools('review'),
          warning: deps.events.warning,
        },
      )
    }
    stop()
    const recheck = await recheckEarlier(input, loaded, language, {
      provider: () => watch(provider, 'recheck'),
      tools: () => investigation?.tools('recheck'),
      warning: deps.events.warning,
    })
    stop()
    const outcome = await runReview(
      {
        pullRequest: { ...pullRequest, diff: loaded.diff },
        language,
        minConfidence: options.minConfidence ?? loaded.options.minConfidence,
        verify: options.verify ?? loaded.options.verify ?? true,
        context: loaded.context,
        ...(impact === undefined ? {} : { impact }),
        ...(related === undefined ? {} : { related }),
        ...(conversation === undefined ? {} : { conversation }),
        ...(ci === undefined ? {} : { ci }),
        ...(planned.passes === undefined ? {} : { passes: planned.passes }),
      },
      {
        provider: watch(provider, 'review'),
        verifier: watch(provider, 'verify'),
        ...(investigation === undefined ? {} : { tools: investigation.tools }),
        ...(native === undefined ? {} : { runSkill: native.runSkill }),
        events: {
          passStarted: (pass, index) =>
            deps.events.passStarted?.(pass.skill, index, planned.passes?.length ?? 1),
        },
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
      ...mcpReports(investigation !== undefined, outside, input.mcp, mcpOpened),
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
      ...(recheck === undefined ? {} : { recheck }),
      ...(planned.passes === undefined ? {} : { passes: planned.plan }),
      ...(input.conversation === undefined ? {} : { conversation: input.conversation }),
      ...(input.ci === undefined ? {} : { ci: input.ci }),
    }
  } finally {
    await native?.close()
    if (investigation === undefined) await headCheckout?.close()
    else await investigation.close()
    for (const item of opened) await item.close()
    head.store?.close()
    head.observed?.close()
  }
}

async function recheckEarlier(
  input: PullRequestReviewInput,
  loaded: LoadedContext,
  language: string | undefined,
  run: {
    provider: () => ReviewProvider
    tools: () => Toolbox | undefined
    warning: (message: string) => void
  },
): Promise<RecheckReport | undefined> {
  if (input.recheck === undefined || input.recheck.length === 0) return undefined
  try {
    return await recheckThreads(
      {
        pullRequest: { ...input.pullRequest, diff: loaded.diff },
        context: loaded.context,
        ...(language === undefined ? {} : { language }),
      },
      input.recheck,
      run.provider(),
      undefined,
      run.tools(),
    )
  } catch (error) {
    stopIfCancelled(input.signal, error)
    run.warning(`Earlier comments were not rechecked: ${errorMessage(error)}`)
    return undefined
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
  signal: AbortSignal | undefined,
): Promise<HeadGraph> {
  const { mirror, sha, checkout } = opened
  let store: IndexStore | undefined
  let observed: ObservedStore | undefined
  try {
    const files = await mirror.listFiles(sha)
    store = await deps.openIndexStore()
    const deadline = deps.now() + REVIEW_INDEX_BUDGET_MS
    const result = await indexForReview(
      {
        sha,
        ref: `refs/phada/pull/${pullRequest.number}`,
        files,
        ignore: loaded.ignore,
        deadline,
        ...(signal === undefined ? {} : { signal }),
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
      stopIfCancelled(signal)
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
    stopIfCancelled(signal, error)
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

function mcpReports(
  investigated: boolean,
  outside: boolean,
  mcp: ResolvedMcp,
  opened: OpenedMcp | undefined,
): { mcp?: McpServerReport[] } {
  if (!investigated) return {}
  const reports = outside ? mcpOff(mcp) : (opened?.reports ?? [])
  return reports.length === 0 ? {} : { mcp: reports }
}
