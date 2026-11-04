import { isNearMiss } from '../publish/misses.js'
import type { FindingPlace } from '../publish/misses.js'
import type {
  HistoryStore,
  MissFilter,
  MissOutcome,
  MissRecord,
  MissReplayRecord,
} from '../store/history-store.js'
import type { Extractor } from '../repo-map/extract.js'
import { codeElements } from './code-elements.js'
import type { CodeElements, ReadFileAt } from './code-elements.js'
import { errorMessage } from './error-message.js'
import { latestTally } from './miss-tally.js'
import type { VersionTally } from './miss-tally.js'
import { ReviewCancelledError } from './review-cancelled.js'

export type { VersionTally } from './miss-tally.js'

export interface MissGroup {
  repo: string
  number: number
  commitSha: string
  misses: number
  position: number
  groups: number
}

export interface MissReplayRun {
  runId?: number
  findings: readonly FindingPlace[]
}

export type ReplayedMiss =
  | { miss: MissRecord; outcome: MissOutcome; runId?: number }
  | { miss: MissRecord; outcome: 'failed'; error: string }

export interface MissesReplay {
  version: string
  misses: ReplayedMiss[]
  tally: VersionTally
  earlier?: VersionTally
  left: number
}

export interface ReplayMissesEvents {
  started?(groups: number, misses: number): void
  replaying(group: MissGroup): void
  failed(group: MissGroup, error: string): void
}

export interface ReplayMissesDeps {
  history: Pick<HistoryStore, 'misses' | 'recordMissReplays' | 'missReplays'>
  replay(pull: { repo: string; number: number }, sha: string): Promise<MissReplayRun>
  readFile: ReadFileAt
  extractor: Extractor
  now(): string
  events: ReplayMissesEvents
  signal?: AbortSignal
}

export interface ReplayMissesInput {
  filter: Pick<MissFilter, 'repo' | 'number'>
  version: string
}

export async function replayMisses(
  { filter, version }: ReplayMissesInput,
  deps: ReplayMissesDeps,
): Promise<MissesReplay> {
  const open = deps.history.misses({ ...filter, state: 'open' }).misses
  const groups = groupMisses(open)
  deps.events.started?.(groups.length, open.length)
  const replayed: ReplayedMiss[] = []
  const stopped = () => deps.signal?.aborted === true
  const elements = codeElements(deps.readFile, deps.extractor)
  let left = open.length
  for (const [index, misses] of groups.entries()) {
    if (stopped()) break
    const [first] = misses
    if (first === undefined) continue
    const group: MissGroup = {
      repo: first.repo,
      number: first.number,
      commitSha: first.commitSha,
      misses: misses.length,
      position: index + 1,
      groups: groups.length,
    }
    deps.events.replaying(group)
    let run: MissReplayRun
    const decided: { miss: MissRecord; outcome: MissOutcome }[] = []
    try {
      run = await deps.replay({ repo: group.repo, number: group.number }, group.commitSha)
      for (const miss of misses) {
        decided.push({
          miss,
          outcome: (await caught(miss, run.findings, elements)) ? 'caught' : 'missed',
        })
      }
    } catch (error) {
      if (error instanceof ReviewCancelledError || stopped()) break
      const message = errorMessage(error)
      deps.events.failed(group, message)
      replayed.push(...misses.map((miss) => ({ miss, outcome: 'failed' as const, error: message })))
      left -= misses.length
      continue
    }
    const runId = run.runId === undefined ? {} : { runId: run.runId }
    const outcomes = decided.map(({ miss, outcome }) => {
      const record: MissReplayRecord = {
        missId: miss.id,
        version,
        ...runId,
        outcome,
        replayedAt: deps.now(),
      }
      return { record, replayed: { miss, outcome, ...runId } }
    })
    deps.history.recordMissReplays(outcomes.map(({ record }) => record))
    replayed.push(...outcomes.map((item) => item.replayed))
    left -= misses.length
  }
  return { version, misses: replayed, ...tallies(replayed, version, deps.history), left }
}

async function caught(
  miss: MissRecord,
  findings: readonly FindingPlace[],
  elements: CodeElements,
): Promise<boolean> {
  const inFile = findings.filter((finding) => finding.file === miss.file)
  if (inFile.length === 0) return false
  const spans = await elements(miss.repo, miss.commitSha, miss.file)
  return inFile.some((finding) => isNearMiss(miss, finding, spans))
}

function groupMisses(misses: readonly MissRecord[]): MissRecord[][] {
  const groups = new Map<string, MissRecord[]>()
  for (const miss of [...misses].sort(byPullThenAge)) {
    const key = `${miss.repo}#${miss.number}@${miss.commitSha}`
    groups.set(key, [...(groups.get(key) ?? []), miss])
  }
  return [...groups.values()]
}

function byPullThenAge(a: MissRecord, b: MissRecord): number {
  return (
    a.repo.localeCompare(b.repo) ||
    a.number - b.number ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id - b.id
  )
}

function tallies(
  replayed: readonly ReplayedMiss[],
  version: string,
  history: Pick<HistoryStore, 'missReplays'>,
): Pick<MissesReplay, 'tally' | 'earlier'> {
  const done = replayed.filter(({ outcome }) => outcome !== 'failed')
  const tally = {
    version,
    caught: done.filter(({ outcome }) => outcome === 'caught').length,
    replayed: done.length,
  }
  const earlier = latestTally(history.missReplays(done.map(({ miss }) => miss.id)), version)
  return { tally, ...(earlier === undefined ? {} : { earlier }) }
}
