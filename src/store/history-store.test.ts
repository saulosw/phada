import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { HISTORY_MIGRATIONS } from './history-migrations.js'
import { HistoryStoreError, HistoryVersionError, openHistoryStore } from './history-store.js'
import type { RunRecord } from './history-store.js'
import type { JobRecord } from '../watch/types.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-history-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let files = 0
const fresh = () => join(dir, `h${++files}`, 'history.sqlite')

const JOB: Omit<JobRecord, 'id'> = {
  repo: 'acme/shop',
  number: 3,
  headSha: 'a'.repeat(40),
  status: 'queued',
  attempts: 0,
  notBefore: '2026-10-18T12:03:00.000Z',
  createdAt: '2026-10-18T12:00:00.000Z',
}

const RUN: RunRecord = {
  source: 'watch',
  repo: 'acme/shop',
  number: 3,
  headSha: 'a'.repeat(40),
  startedAt: '2026-10-18T12:03:00.000Z',
  finishedAt: '2026-10-18T12:06:00.000Z',
  status: 'published',
  aiCalled: true,
  provider: 'claude',
  findings: 2,
  score: 3,
  url: 'https://github.com/acme/shop/pull/3#pullrequestreview-1',
  resultJson: '{"schemaVersion":1}',
}

function userVersion(path: string): number {
  const db = new DatabaseSync(path)
  const version = Number(db.prepare('pragma user_version').get()?.user_version)
  db.close()
  return version
}

describe('openHistoryStore migrations', () => {
  it('creates a new file at the latest version with every table', async () => {
    const path = fresh()
    const store = await openHistoryStore(path)
    store.close()

    const db = new DatabaseSync(path)
    const tables = db
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((row) => row.name)
    db.close()
    expect(userVersion(path)).toBe(HISTORY_MIGRATIONS.length)
    expect(tables).toEqual([
      'feedback_pull',
      'finding',
      'job',
      'run',
      'signal',
      'watch_state',
      'watched_pull',
      'watched_repo',
    ])
  })

  it('keeps what is stored across openings', async () => {
    const path = fresh()
    const store = await openHistoryStore(path)
    store.saveRepo({ repo: 'Acme/Shop', pullsEtag: 'W/"1"' })
    store.close()

    const reopened = await openHistoryStore(path)
    expect(reopened.repo('acme/shop')).toEqual({ repo: 'acme/shop', pullsEtag: 'W/"1"' })
    reopened.close()
  })

  it('refuses a file written by a newer version and leaves it as it is', async () => {
    const path = fresh()
    ;(await openHistoryStore(path)).close()
    const db = new DatabaseSync(path)
    db.exec('pragma user_version = 99')
    db.close()
    const before = readFileSync(path)

    const opened = openHistoryStore(path)

    await expect(opened).rejects.toBeInstanceOf(HistoryVersionError)
    await expect(opened).rejects.toMatchObject({ found: 99, known: HISTORY_MIGRATIONS.length })
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  it('refuses a file that is not a database without deleting it', async () => {
    const path = fresh()
    ;(await openHistoryStore(path)).close()
    writeFileSync(path, 'not sqlite at all, just some text that is long enough')

    await expect(openHistoryStore(path)).rejects.toBeInstanceOf(HistoryStoreError)
    expect(readFileSync(path, 'utf8')).toContain('not sqlite')
  })

  it('rolls back a migration that fails half way', async () => {
    const path = fresh()
    const migrations = [
      ...HISTORY_MIGRATIONS,
      { version: HISTORY_MIGRATIONS.length + 1, sql: 'create table extra (x); this is not sql;' },
    ]

    await expect(openHistoryStore(path, { migrations })).rejects.toBeInstanceOf(HistoryStoreError)

    const db = new DatabaseSync(path)
    const extra = db.prepare("select name from sqlite_master where name = 'extra'").get()
    db.close()
    expect(extra).toBeUndefined()
    expect(userVersion(path)).toBe(HISTORY_MIGRATIONS.length)
  })
})

describe('HistoryStore records', () => {
  it('adds, lists and updates jobs', async () => {
    const store = await openHistoryStore(fresh())
    const id = store.addJob({ ...JOB, repo: 'Acme/Shop' })
    store.addJob({ ...JOB, number: 4, status: 'done' })

    store.updateJob(id, { status: 'running', startedAt: '2026-10-18T12:03:00.000Z' })

    expect(store.jobs({ status: ['running'] })).toEqual([
      { ...JOB, id, status: 'running', startedAt: '2026-10-18T12:03:00.000Z' },
    ])
    expect(store.jobs({ repo: 'acme/shop' })).toHaveLength(2)
    store.close()
  })

  it('puts interrupted jobs back in the queue and fails the ones out of attempts', async () => {
    const store = await openHistoryStore(fresh())
    const once = store.addJob({ ...JOB, status: 'running', attempts: 0 })
    const twice = store.addJob({ ...JOB, number: 4, status: 'running', attempts: 2 })

    const recovered = store.recoverRunning(3, '2026-10-18T13:00:00.000Z')

    expect(recovered.map((job) => job.id)).toEqual([once, twice])
    expect(store.jobs({ status: ['queued'] })).toEqual([
      expect.objectContaining({ id: once, attempts: 1 }),
    ])
    expect(store.jobs({ status: ['failed'] })).toEqual([
      expect.objectContaining({
        id: twice,
        attempts: 3,
        errorKind: 'transient',
        error: 'interrupted',
        finishedAt: '2026-10-18T13:00:00.000Z',
      }),
    ])
    store.close()
  })

  it('counts only watch runs that called the AI since a time', async () => {
    const store = await openHistoryStore(fresh())
    store.addRun(RUN)
    store.addRun({ ...RUN, startedAt: '2026-10-18T11:00:00.000Z' })
    store.addRun({ ...RUN, source: 'manual' })
    store.addRun({ ...RUN, aiCalled: false, status: 'skipped' })

    expect(store.watchRunsSince('2026-10-18T11:30:00.000Z')).toEqual(['2026-10-18T12:03:00.000Z'])
    store.close()
  })

  it('stores pull requests per repository', async () => {
    const store = await openHistoryStore(fresh())
    const pull = {
      repo: 'acme/shop',
      number: 3,
      headSha: 'a'.repeat(40),
      headSeenAt: '2026-10-18T12:00:00.000Z',
      baselineSha: 'a'.repeat(40),
      eligible: true,
      state: 'open' as const,
    }
    store.savePull(pull)
    store.savePull({ ...pull, headSha: 'b'.repeat(40) })

    expect(store.pulls('Acme/Shop')).toEqual([{ ...pull, headSha: 'b'.repeat(40) }])
    store.close()
  })

  it('sets and clears the pause', async () => {
    const store = await openHistoryStore(fresh())
    store.setPause({ until: '2026-10-18T12:15:00.000Z', reason: 'usage-limit', streak: 1 })
    expect(store.pause()).toEqual({
      until: '2026-10-18T12:15:00.000Z',
      reason: 'usage-limit',
      streak: 1,
    })

    store.setPause(undefined)

    expect(store.pause()).toBeUndefined()
    store.close()
  })

  it('reports the status without the review JSON', async () => {
    const store = await openHistoryStore(fresh())
    store.saveRepo({ repo: 'acme/shop', checkedAt: '2026-10-18T12:00:00.000Z' })
    store.addJob(JOB)
    store.addJob({ ...JOB, number: 5, status: 'running' })
    store.addJob({ ...JOB, number: 6, status: 'failed', error: 'boom', errorKind: 'definitive' })
    store.addRun({
      ...RUN,
      startedAt: '2026-10-18T10:00:00.000Z',
      finishedAt: '2026-10-18T10:01:00.000Z',
    })
    store.addRun(RUN)

    const status = store.status()

    expect(status.repos).toEqual([{ repo: 'acme/shop', checkedAt: '2026-10-18T12:00:00.000Z' }])
    expect(status.queued.map((job) => job.number)).toEqual([3])
    expect(status.running.map((job) => job.number)).toEqual([5])
    expect(status.failed.map((job) => job.error)).toEqual(['boom'])
    const { resultJson: _json, ...withoutJson } = RUN
    expect(status.lastRuns).toEqual([{ ...withoutJson, id: expect.any(Number) }])
    expect(status.pause).toBeUndefined()
    store.close()
  })
})
