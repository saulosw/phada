import type { JobRecord, RunEnd } from './types.js'

export interface JobNotice {
  kind: 'finished' | 'skipped'
  job: JobRecord
  reason?: string
}

export type AfterRun = { clearPause: boolean } & (
  | { failed: unknown }
  | {
      job: Partial<Omit<JobRecord, 'id'>>
      notice: JobNotice
      pullHead?: string
      follow?: true
    }
)

export function afterRun(job: JobRecord, end: RunEnd, now: string): AfterRun {
  const clearPause = end.status === 'reviewed'
  const ended = { ...job, finishedAt: now }
  if (end.status === 'skipped') {
    const reason = end.reason.kind
    return {
      clearPause,
      job: { status: 'skipped', reason, finishedAt: now },
      notice: { kind: 'skipped', job: ended, reason },
    }
  }
  const publication = end.publication
  switch (publication?.status) {
    case 'failed':
      return { clearPause, failed: publication.error }
    case 'superseded':
      return {
        clearPause,
        job: { status: 'superseded', finishedAt: now },
        notice: { kind: 'skipped', job: ended, reason: 'superseded' },
        pullHead: publication.headSha,
        follow: true,
      }
    case 'closed-or-draft':
      return {
        clearPause,
        job: { status: 'skipped', reason: 'closed-or-draft', finishedAt: now },
        notice: { kind: 'skipped', job: ended, reason: 'closed-or-draft' },
      }
    default:
      return {
        clearPause,
        job: { status: 'done', finishedAt: now },
        notice: { kind: 'finished', job: { ...ended, status: 'done' } },
      }
  }
}
