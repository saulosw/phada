import type { Ci, ContextReport } from '../context/types.js'
import type { PullRequest } from '../github/pull-request.js'
import type { ImpactReport } from '../graph/report.js'
import type { ReviewPass } from '../investigation/tools/tool-log.js'
import type { ReviewProvider } from '../providers/types.js'
import type { Conversation } from '../publish/types.js'
import type { RelatedReport } from './related-report.js'
import type { PassPlan } from './review-passes.js'
import type { CiWaited, CiWaiting } from './wait-for-ci.js'
import { wrapProviderRuns } from './wrap-provider-runs.js'

export type AiRun = ReviewPass | 'skill'

export type ReviewProgress =
  | { kind: 'fetched'; pullRequest: PullRequest }
  | { kind: 'conversationRead'; conversation: Conversation }
  | { kind: 'ciRead'; ci: Ci }
  | { kind: 'ciWaiting'; wait: CiWaiting }
  | { kind: 'ciWaited'; wait: CiWaited }
  | { kind: 'contextLoaded'; report: ContextReport; baseSha: string }
  | { kind: 'indexing'; total: number }
  | { kind: 'indexed'; done: number; total: number }
  | { kind: 'relatedReady'; report: RelatedReport }
  | { kind: 'impactReady'; report: ImpactReport }
  | { kind: 'passesPlanned'; plan: PassPlan[] }
  | { kind: 'passStarted'; skill: string; index: number; total: number }
  | { kind: 'aiStarted'; provider: string; run: AiRun }
  | { kind: 'aiFinished'; provider: string; run: AiRun; answered: boolean }
  | { kind: 'publishing' }
  | { kind: 'warning'; message: string }

export type ReviewProgressSink = (event: ReviewProgress) => void

export function reportProgress(
  provider: ReviewProvider,
  pass: ReviewPass,
  progress: ReviewProgressSink,
): ReviewProvider {
  const running = async <T>(run: AiRun, work: () => Promise<T>): Promise<T> => {
    progress({ kind: 'aiStarted', provider: provider.id, run })
    let answered = false
    try {
      const output = await work()
      answered = true
      return output
    } finally {
      progress({ kind: 'aiFinished', provider: provider.id, run, answered })
    }
  }
  return wrapProviderRuns(provider, (run, work) => running(run === 'review' ? pass : 'skill', work))
}
