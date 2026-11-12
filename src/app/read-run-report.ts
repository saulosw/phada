import type { ContextReport } from '../context/types.js'
import type { ImpactReport } from '../graph/report.js'
import type { InvestigationReport } from '../investigation/tools/report.js'
import type { TokenUsage } from '../providers/types.js'
import type { UsageReport } from '../review/token-usage.js'
import type { Coverage, DiffGroupReport, UsagePass } from '../review/types.js'
import type { RelatedReport } from './related-report.js'
import type { HistoryReader, RunRecord } from './read-history.js'
import type {
  CiBlock,
  ConversationBlock,
  PostedReview,
  StoredPasses,
} from './stored-report-blocks.js'
import { readStoredRun, titledFindings } from './stored-run.js'
import type {
  StoredCi,
  StoredClaim,
  StoredFinding,
  StoredRunReview,
  StoredTokens,
  StoredUsage,
} from './stored-run.js'

export interface RunReport {
  run: Omit<RunRecord, 'resultJson'>
  result: unknown
  title: string | null
  publishedFrom?: number
  posted?: PostedReview
  closeToCut?: { minConfidence: number; findings: StoredFinding[] }
  claims?: StoredClaim[]
  context?: ContextReport | null
  conversation?: ConversationBlock | null
  ci?: CiBlock | null
  checks?: StoredCi
  impact?: { report: ImpactReport; text?: string } | null
  related?: RelatedReport | null
  passes?: StoredPasses
  groups?: DiffGroupReport[]
  investigation?: InvestigationReport | null
  coverage?: Coverage
  usage?: UsageReport
}

export function readRunReport(
  history: Pick<HistoryReader, 'run'> | undefined,
  id: number,
): RunReport | undefined {
  const stored = history?.run(id)
  return stored === undefined ? undefined : runReportOf(stored)
}

function runReportOf(stored: RunRecord): RunReport {
  const { resultJson, ...run } = stored
  const view = readStoredRun(resultJson)
  const { review } = view
  return {
    run,
    result: view.document ?? null,
    title: view.pullRequest === null ? view.localTitle : view.pullRequest.title,
    ...defined('publishedFrom', view.publishedFrom ?? undefined),
    ...defined('posted', view.publication?.posted ?? undefined),
    ...defined('closeToCut', closeToCutOf(review)),
    ...defined('claims', review?.claims ?? undefined),
    ...defined('context', view.context),
    ...defined('conversation', view.conversation),
    ...defined('ci', view.ciBlock),
    ...(view.ciBlock === undefined ? defined('checks', view.ci ?? undefined) : {}),
    ...defined('impact', view.impact),
    ...defined('related', view.related),
    ...defined('passes', review?.passes ?? undefined),
    ...defined('groups', review?.groups ?? undefined),
    ...defined('investigation', view.investigation),
    ...defined('coverage', review?.coverage ?? undefined),
    ...defined('usage', view.usage === null ? undefined : usageReportOf(view.usage)),
  }
}

function defined<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}

function closeToCutOf(review: StoredRunReview | null): RunReport['closeToCut'] | undefined {
  if (review === null) return undefined
  const { minConfidence, findings, closeToCutMarked } = review
  if (minConfidence === null || findings === null || !closeToCutMarked) return undefined
  return { minConfidence, findings: titledFindings(findings) }
}

const USAGE_PASSES: ReadonlySet<string> = new Set<UsagePass>([
  'review',
  'continuation',
  'verify',
  'recheck',
])

function usageReportOf({ passes, total }: StoredUsage): UsageReport {
  return {
    passes: passes.flatMap(({ pass, skill, group, tokens }) =>
      isUsagePass(pass)
        ? [
            {
              pass,
              ...(skill === null ? {} : { skill }),
              ...(group === null ? {} : { group }),
              ...(tokens === null ? {} : { usage: tokenUsageOf(tokens) }),
            },
          ]
        : [],
    ),
    ...(total === null ? {} : { total: tokenUsageOf(total) }),
  }
}

function isUsagePass(pass: string): pass is UsagePass {
  return USAGE_PASSES.has(pass)
}

function tokenUsageOf({ input, cached, output }: StoredTokens): TokenUsage {
  return {
    inputTokens: input,
    ...(cached === null ? {} : { cachedInputTokens: cached }),
    outputTokens: output,
  }
}
