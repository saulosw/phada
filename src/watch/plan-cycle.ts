import type { WatchedRepoSettings } from '../config/watch-settings.js'
import type { OpenPull } from '../github/list-pull-requests.js'
import type { JobRecord, PullRecord, RequestRecord } from './types.js'
import { later } from './time.js'
import { eligibility } from './filters.js'
import { notStarted } from './next-job.js'
import { CI_REVISIT_MS, skippedForCi } from './ci-revisit.js'

export interface CycleInput {
  repo: WatchedRepoSettings
  pulls: readonly OpenPull[]
  stored: readonly PullRecord[]
  jobs: readonly JobRecord[]
  baselineDone: boolean
  backfill: boolean
  now: string
  settleMs: number
  requests: readonly RequestRecord[]
}

export type CycleAction =
  | { kind: 'baseline'; pulls: PullRecord[] }
  | { kind: 'seen'; pull: PullRecord }
  | { kind: 'enqueue'; job: Omit<JobRecord, 'id'> }
  | { kind: 'join'; jobId: number }
  | { kind: 'supersede'; jobId: number }
  | { kind: 'move'; jobId: number }
  | { kind: 'gone'; pull: PullRecord; jobIds: number[] }

export function planCycle(input: CycleInput): CycleAction[] {
  const { repo, now } = input
  if (!input.baselineDone && !input.backfill) {
    return [
      {
        kind: 'baseline',
        pulls: input.pulls.map((pull) => {
          const eligible = eligibility(pull, repo).eligible
          return {
            ...record(repo.repo, pull, now, eligible),
            ...(eligible ? { baselineSha: pull.headSha } : {}),
          }
        }),
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
      if (notStarted(job) && job.headSha !== pull.headSha) {
        actions.push({ kind: 'supersede', jobId: job.id })
      } else if (newCommit && job.headSha !== pull.headSha && revisitedForCi(job, now)) {
        actions.push({ kind: 'move', jobId: job.id })
      }
    }
    const known = jobs.some(
      (job) =>
        job.headSha === pull.headSha &&
        blocks(job) &&
        !(repo.publish === 'pr' && !notStarted(job) && job.publish === 'none'),
    )
    if (!eligible || current.baselineSha === pull.headSha) continue
    if (known) {
      const asked = jobs.find(
        (job) =>
          job.headSha === pull.headSha && notStarted(job) && askedElsewhere(job, input.requests),
      )
      if (asked !== undefined) actions.push({ kind: 'join', jobId: asked.id })
      continue
    }
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
        publish: repo.publish,
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
        .filter((job) => job.number === before.number && notStarted(job))
        .map((job) => job.id),
    })
  }
  return actions
}

function record(repo: string, pull: OpenPull, headSeenAt: string, eligible: boolean): PullRecord {
  return { repo, number: pull.number, headSha: pull.headSha, headSeenAt, eligible, state: 'open' }
}

function blocks(job: JobRecord): boolean {
  if (job.status === 'superseded') return false
  return !(
    job.status === 'skipped' &&
    (job.reason === 'closed' || job.reason === 'closed-or-draft')
  )
}

function revisitedForCi(job: JobRecord, now: string): boolean {
  return (
    skippedForCi(job) && job.finishedAt !== undefined && later(job.finishedAt, CI_REVISIT_MS) > now
  )
}

function askedElsewhere(job: JobRecord, requests: readonly RequestRecord[]): boolean {
  const sources = requests.filter(({ jobId }) => jobId === job.id)
  return sources.length > 0 && sources.every(({ source }) => source !== 'watch')
}
