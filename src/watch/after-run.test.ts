import { describe, expect, it } from 'vitest'
import type { JobRecord } from './types.js'
import { afterRun } from './after-run.js'

const STARTED = '2026-10-18T12:00:00.000Z'
const NOW = '2026-10-18T12:05:00.000Z'
const RUNNING: JobRecord = {
  id: 1,
  repo: 'acme/shop',
  number: 3,
  headSha: 'a'.repeat(40),
  status: 'running',
  attempts: 0,
  notBefore: STARTED,
  createdAt: STARTED,
  startedAt: STARTED,
}

describe('afterRun', () => {
  it('finishes the job and notifies it as done when the review is published', () => {
    expect(
      afterRun(RUNNING, { status: 'reviewed', publication: { status: 'published' } }, NOW),
    ).toEqual({
      clearPause: true,
      job: { status: 'done', finishedAt: NOW },
      notice: { kind: 'finished', job: { ...RUNNING, status: 'done', finishedAt: NOW } },
    })
  })

  it('finishes the job without clearing the pause when the review found nothing', () => {
    expect(afterRun(RUNNING, { status: 'nothing' }, NOW)).toEqual({
      clearPause: false,
      job: { status: 'done', finishedAt: NOW },
      notice: { kind: 'finished', job: { ...RUNNING, status: 'done', finishedAt: NOW } },
    })
  })

  it('skips the job for the reason the review gave', () => {
    expect(
      afterRun(RUNNING, { status: 'skipped', reason: { kind: 'already-reviewed' } }, NOW),
    ).toEqual({
      clearPause: false,
      job: { status: 'skipped', reason: 'already-reviewed', finishedAt: NOW },
      notice: {
        kind: 'skipped',
        job: { ...RUNNING, finishedAt: NOW },
        reason: 'already-reviewed',
      },
    })
  })

  it('hands a failed publication to the failure path with its error', () => {
    const error = new Error('GitHub refused the review')

    expect(
      afterRun(RUNNING, { status: 'reviewed', publication: { status: 'failed', error } }, NOW),
    ).toEqual({ clearPause: true, failed: error })
  })

  it('supersedes the job, moves the pull to the new head and follows its requests', () => {
    const headSha = 'b'.repeat(40)

    expect(
      afterRun(
        RUNNING,
        { status: 'reviewed', publication: { status: 'superseded', headSha } },
        NOW,
      ),
    ).toEqual({
      clearPause: true,
      job: { status: 'superseded', finishedAt: NOW },
      notice: { kind: 'skipped', job: { ...RUNNING, finishedAt: NOW }, reason: 'superseded' },
      pullHead: headSha,
      follow: true,
    })
  })

  it('skips the job when the pull request was closed or went back to draft', () => {
    expect(
      afterRun(RUNNING, { status: 'nothing', publication: { status: 'closed-or-draft' } }, NOW),
    ).toEqual({
      clearPause: false,
      job: { status: 'skipped', reason: 'closed-or-draft', finishedAt: NOW },
      notice: {
        kind: 'skipped',
        job: { ...RUNNING, finishedAt: NOW },
        reason: 'closed-or-draft',
      },
    })
  })
})
