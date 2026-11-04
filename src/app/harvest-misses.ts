import type { PullRequestReviewState } from '../github/pull-request-reviews.js'
import { decideMisses } from '../publish/misses.js'
import type { FindingPlace, LocalReview } from '../publish/misses.js'
import type { DuePull, HistoryStore, RunRecord } from '../store/history-store.js'
import { numberOf, objectOf, parseJson, stringOf } from './stored-json.js'

export function harvestMisses(
  history: HistoryStore,
  pull: DuePull,
  state: PullRequestReviewState,
  now: string,
): number {
  const misses = decideMisses({
    repo: pull.repo,
    number: pull.number,
    state,
    localReviews: history.aiRuns(pull).map(localReview),
  })
  return misses.length === 0 ? 0 : history.recordMisses(misses, now)
}

function localReview(run: RunRecord): LocalReview {
  return { sha: run.headSha, at: run.finishedAt, findings: storedFindings(run.resultJson) }
}

function storedFindings(resultJson: string | undefined): FindingPlace[] {
  const findings = objectOf(objectOf(parseJson(resultJson))?.review)?.findings
  if (!Array.isArray(findings)) return []
  return findings.flatMap((finding: unknown) => {
    const item = objectOf(finding)
    const file = stringOf(item?.file)
    const line = numberOf(item?.line)
    return file === undefined || line === undefined ? [] : [{ file, line }]
  })
}
