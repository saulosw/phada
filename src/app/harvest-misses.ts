import type { ComparedFile } from '../github/compare-commits.js'
import type { PullRequestReviewState } from '../github/pull-request-reviews.js'
import { decideMisses, missElementSites, siteKey } from '../publish/misses.js'
import type { ElementSite, LineSpan, LocalReview, MissInput } from '../publish/misses.js'
import {
  comparisonKey,
  decideVanished,
  vanishedComparisons,
  vanishedElementSites,
} from '../publish/vanished-findings.js'
import type { FindingRun, RunFinding, VanishedInput } from '../publish/vanished-findings.js'
import type { DuePull, HistoryStore, RunRecord } from '../store/history-store.js'
import type { CodeElements } from './code-elements.js'
import { remembered } from './remembered.js'
import { readStoredRun } from './stored-run.js'
import type { StoredRun } from './stored-run.js'

export type CompareCommits = (
  repo: string,
  base: string,
  head: string,
) => Promise<readonly ComparedFile[] | 'unavailable'>

interface Harvest {
  pull: DuePull
  state: PullRequestReviewState
  bots: readonly string[]
  elements: CodeElements
  compare: CompareCommits
  now: string
}

export function comparedCommits(compare: CompareCommits): CompareCommits {
  return remembered(
    (repo: string, base: string, head: string) =>
      `${repo.toLowerCase()}\0${comparisonKey(base, head)}`,
    compare,
  )
}

export async function harvestMisses(
  history: HistoryStore,
  { pull, state, bots, elements, compare, now }: Harvest,
): Promise<number> {
  const threads: MissInput = {
    repo: pull.repo,
    number: pull.number,
    state,
    localReviews: history.aiRuns(pull).map(localReview),
    bots,
  }
  const vanished: VanishedInput = {
    repo: pull.repo,
    number: pull.number,
    runs: history.aiRuns(pull, { replays: true }).flatMap(findingRun),
    state,
    known: new Set(history.misses(pull).misses.map(({ key }) => key)),
  }
  const read = await readElements(pull.repo, elements, [
    ...missElementSites(threads),
    ...vanishedElementSites(vanished),
  ])
  const elementsAt = (commitSha: string, file: string) => read.get(siteKey(commitSha, file))
  const comparisons = new Map<string, readonly ComparedFile[] | 'unavailable'>()
  for (const { base, head } of vanishedComparisons({ ...vanished, elementsAt })) {
    comparisons.set(comparisonKey(base, head), await compare(pull.repo, base, head))
  }
  const misses = [
    ...decideMisses({ ...threads, elementsAt }),
    ...decideVanished({ ...vanished, elementsAt, comparisons }),
  ]
  return misses.length === 0 ? 0 : history.recordMisses(misses, now)
}

async function readElements(
  repo: string,
  elements: CodeElements,
  sites: readonly ElementSite[],
): Promise<Map<string, readonly LineSpan[] | undefined>> {
  const read = new Map<string, readonly LineSpan[] | undefined>()
  for (const { commitSha, file } of sites) {
    const key = siteKey(commitSha, file)
    if (!read.has(key)) read.set(key, await elements(repo, commitSha, file))
  }
  return read
}

function localReview(run: RunRecord): LocalReview {
  return {
    sha: run.headSha,
    at: run.finishedAt,
    findings: reportedFindings(readStoredRun(run.resultJson)) ?? [],
  }
}

function findingRun(run: RunRecord): FindingRun[] {
  const findings = reportedFindings(readStoredRun(run.resultJson))
  if (run.id === undefined || findings === undefined || run.source === 'local') return []
  const { id, headSha, source, finishedAt } = run
  return [{ id, headSha, source, finishedAt, findings }]
}

export function reportedFindings({ review }: StoredRun): RunFinding[] | undefined {
  return review?.findings?.flatMap(({ file, line, title, why }) =>
    line === null ? [] : [{ file, line, title: title ?? '', body: why ?? '' }],
  )
}
