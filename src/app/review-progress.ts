import type { Ci, ContextReport } from '../context/types.js'
import type { PullRequest } from '../github/pull-request.js'
import type { ImpactReport } from '../graph/report.js'
import type { ReviewPass } from '../investigation/tools/tool-log.js'
import type { ReviewPrompt, ReviewProvider, SkillRunRequest } from '../providers/types.js'
import type { Conversation } from '../publish/types.js'
import type { RelatedReport } from './related-report.js'
import type { PassPlan } from './review-passes.js'
import type { CiWaited, CiWaiting } from './wait-for-ci.js'

export type AiRun = ReviewPass | 'skill'

export type ReviewProgress =
  | { kind: 'fetched'; pullRequest: PullRequest }
  | { kind: 'conversationRead'; conversation: Conversation }
  | { kind: 'ciRead'; ci: Ci }
  | { kind: 'ciWaiting'; wait: CiWaiting }
  | { kind: 'ciWaited'; wait: CiWaited }
  | { kind: 'contextLoaded'; report: ContextReport }
  | { kind: 'indexing'; total: number }
  | { kind: 'indexed'; done: number; total: number }
  | { kind: 'relatedReady'; report: RelatedReport }
  | { kind: 'impactReady'; report: ImpactReport }
  | { kind: 'passesPlanned'; plan: PassPlan[] }
  | { kind: 'passStarted'; skill: string; index: number; total: number }
  | { kind: 'aiStarted'; provider: string; run: AiRun }
  | { kind: 'aiFinished'; provider: string; run: AiRun }
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
    try {
      return await work()
    } finally {
      progress({ kind: 'aiFinished', provider: provider.id, run })
    }
  }
  const runSkill = provider.runSkill?.bind(provider)
  return {
    id: provider.id,
    review: (prompt: ReviewPrompt) => running(pass, () => provider.review(prompt)),
    ...(runSkill === undefined
      ? {}
      : { runSkill: (request: SkillRunRequest) => running('skill', () => runSkill(request)) }),
  }
}
