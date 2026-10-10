import type { ConfigLayer } from '../config/types.js'
import { loadContext } from '../context/load-context.js'
import type { ContextReport, ContextSources, LoadedContext } from '../context/types.js'
import type { PullRequest } from '../github/pull-request.js'
import type { Checkout } from '../investigation/checkout/checkout.js'
import { CheckoutUnavailableError } from '../investigation/checkout/git-checkout.js'
import type { OpenGitCheckoutOptions } from '../investigation/checkout/git-checkout.js'
import { openInvestigation } from '../investigation/open-investigation.js'
import type { Investigation } from '../investigation/open-investigation.js'
import { buildInvestigationReport } from '../investigation/tools/report.js'
import type { InvestigationReport } from '../investigation/tools/report.js'
import type { ReviewPass } from '../investigation/tools/tool-log.js'
import type { ReviewProvider } from '../providers/types.js'
import { runReview } from '../review/run-review.js'
import type { ReviewOutcome } from '../review/types.js'

export interface ReviewOptions {
  language?: string
  minConfidence?: number
  verify?: boolean
  investigate?: boolean
}

export interface PullRequestReviewInput {
  pullRequest: PullRequest
  token: string
  userLayers: readonly ConfigLayer[]
  userMcpServers: readonly string[]
  options: ReviewOptions
}

export interface PullRequestReviewEvents {
  contextLoaded(report: ContextReport): void
  warning(message: string): void
}

export interface PullRequestReviewDeps {
  env: NodeJS.ProcessEnv
  contextSources: ContextSources
  openCheckout: (options: OpenGitCheckoutOptions) => Promise<Checkout>
  createProvider: (userMcpServers: readonly string[]) => ReviewProvider
  watchProvider?: (provider: ReviewProvider, pass: ReviewPass) => ReviewProvider
  events: PullRequestReviewEvents
}

export interface PullRequestReview {
  outcome: ReviewOutcome
  context: LoadedContext
  language?: string
  investigation: InvestigationReport
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

  let investigation: Investigation | undefined
  let unavailable: string | undefined
  if (investigate && loaded.diff.trim() !== '') {
    const [owner = '', repo = ''] = pullRequest.repo.split('/')
    try {
      investigation = await openInvestigation(
        { owner, repo, sha: pullRequest.headSha, token: input.token, env: deps.env },
        deps.openCheckout,
      )
    } catch (error) {
      if (!(error instanceof CheckoutUnavailableError)) throw error
      unavailable = error.message
      deps.events.warning(`${error.message}: reviewing without investigation.`)
    }
  }

  const servers = investigation === undefined ? [] : input.userMcpServers
  if (servers.length > 0 && !pullRequest.private) {
    deps.events.warning(
      `${pullRequest.repo} is public: what the AI reads from ${servers.join(', ')} may end up in the published review.`,
    )
  }

  let outcome: ReviewOutcome
  try {
    const provider = deps.createProvider(servers)
    const watch = deps.watchProvider ?? ((watched: ReviewProvider) => watched)
    outcome = await runReview(
      {
        pullRequest: { ...pullRequest, diff: loaded.diff },
        language,
        minConfidence: options.minConfidence ?? loaded.options.minConfidence,
        verify: options.verify ?? loaded.options.verify ?? true,
        context: loaded.context,
      },
      {
        provider: watch(provider, 'review'),
        verifier: watch(provider, 'verify'),
        ...(investigation === undefined ? {} : { tools: investigation.tools }),
      },
    )
  } finally {
    await investigation?.close()
  }

  const reviewed = outcome.status === 'reviewed' ? outcome.result : undefined
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
  }
}
