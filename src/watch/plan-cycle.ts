import type { WatchedRepoSettings } from '../config/watch-settings.js'
import type { OpenPull } from '../github/list-pull-requests.js'
import type { JobRecord, PullRecord } from '../store/history-store.js'
import { later } from './failures.js'
import { eligibility } from './filters.js'

export interface CycleInput {
  repo: WatchedRepoSettings
  pulls: readonly OpenPull[]
  stored: readonly PullRecord[]
  jobs: readonly JobRecord[]
  baselineDone: boolean
  backfill: boolean
  now: string
  settleMs: number
}

export type CycleAction =
  | { kind: 'baseline'; pulls: PullRecord[] }
  | { kind: 'seen'; pull: PullRecord }
  | { kind: 'enqueue'; job: Omit<JobRecord, 'id'> }
  | { kind: 'supersede'; jobId: number }
  | { kind: 'gone'; pull: PullRecord; jobIds: number[] }

export function planCycle(input: CycleInput): CycleAction[] {
  const { repo, now } = input
  if (!input.baselineDone && !input.backfill) {
    return [
      {
        kind: 'baseline',
        pulls: input.pulls.map((pull) => ({
          ...record(repo.repo, pull, now, eligibility(pull, repo).eligible),
          baselineSha: pull.headSha,
        })),
      },
    ]
  }
  const backfilling = !input.baselineDone
  const stored = new Map(input.stored.map((pull) => [pull.number, pull]))
  const actions: CycleAction[] = []
  for (const pull of input.pulls) {
    const before = stored.get(pull.number)
    const eligible = eligibility(pull, repo).eligible
    const newCommit =
      before === undefined || before.state === 'gone' || before.headSha !== pull.headSha
    const current: PullRecord = {
      ...record(repo.repo, pull, newCommit ? now : (before?.headSeenAt ?? now), eligible),
      ...(before?.baselineSha === undefined ? {} : { baselineSha: before.baselineSha }),
    }
    if (newCommit || before?.eligible !== eligible) actions.push({ kind: 'seen', pull: current })
    const jobs = input.jobs.filter((job) => job.number === pull.number)
    for (const job of jobs) {
      if (job.status === 'queued' && job.headSha !== pull.headSha) {
        actions.push({ kind: 'supersede', jobId: job.id })
      }
    }
    const known = jobs.some((job) => job.headSha === pull.headSha)
    if (!eligible || known || current.baselineSha === pull.headSha) continue
    const becameEligible = !newCommit && before?.eligible === false
    const notBefore = backfilling
      ? now
      : later(becameEligible ? now : current.headSeenAt, input.settleMs)
    actions.push({
      kind: 'enqueue',
      job: {
        repo: repo.repo,
        number: pull.number,
        headSha: pull.headSha,
        status: 'queued',
        attempts: 0,
        notBefore,
        createdAt: now,
      },
    })
  }
  const listed = new Set(input.pulls.map((pull) => pull.number))
  for (const before of input.stored) {
    if (before.state === 'gone' || listed.has(before.number)) continue
    actions.push({
      kind: 'gone',
      pull: { ...before, state: 'gone' },
      jobIds: input.jobs
        .filter((job) => job.number === before.number && job.status === 'queued')
        .map((job) => job.id),
    })
  }
  return actions
}

function record(repo: string, pull: OpenPull, headSeenAt: string, eligible: boolean): PullRecord {
  return { repo, number: pull.number, headSha: pull.headSha, headSeenAt, eligible, state: 'open' }
}
