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
      'review_request',
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

  it('migrates a version 2 file: its jobs keep their rows and have no publish target', async () => {
    const path = fresh()
    const v2 = await openHistoryStore(path, { migrations: HISTORY_MIGRATIONS.slice(0, 2) })
    const id = v2.addJob(JOB)
    v2.close()

    const store = await openHistoryStore(path)
    expect(store.jobs({})).toEqual([{ ...JOB, id }])
    expect(store.requests([id])).toEqual([])
    store.close()
    expect(userVersion(path)).toBe(3)
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

  it('stores the review requests of each job with their source, target and data', async () => {
    const store = await openHistoryStore(fresh())
    const first = store.addJob({ ...JOB, publish: 'none' })
    const second = store.addJob({ ...JOB, number: 4 })
    const slack = store.addRequest({
      jobId: first,
      source: 'slack',
      publish: 'none',
      data: { channel: 'C1', ts: '1.2' },
      createdAt: '2026-10-18T12:00:00.000Z',
    })
    store.addRequest({
      jobId: second,
      source: 'watch',
      publish: 'pr',
      createdAt: '2026-10-18T12:01:00.000Z',
    })

    expect(store.jobs({ status: ['queued'] })[0]?.publish).toBe('none')
    expect(store.requests([first])).toEqual([
      {
        id: slack,
        jobId: first,
        source: 'slack',
        publish: 'none',
        data: { channel: 'C1', ts: '1.2' },
        createdAt: '2026-10-18T12:00:00.000Z',
      },
    ])
    expect(store.requests([first, second]).map(({ source }) => source)).toEqual(['slack', 'watch'])
    expect(store.requests([])).toEqual([])
    store.close()
  })

  it('reports the sources that asked for each queued and running job', async () => {
    const store = await openHistoryStore(fresh())
    const id = store.addJob(JOB)
    store.addRequest({ jobId: id, source: 'mcp', publish: 'pr', createdAt: JOB.createdAt })
    store.addRequest({ jobId: id, source: 'watch', publish: 'pr', createdAt: JOB.createdAt })
    const legacy = store.addJob({ ...JOB, number: 4 })

    expect(store.status().queued).toEqual([
      { ...JOB, id, sources: ['mcp', 'watch'] },
      { ...JOB, id: legacy, number: 4 },
    ])
    store.close()
  })

  it('returns the last run of a job with its review JSON', async () => {
    const store = await openHistoryStore(fresh())
    const id = store.addJob(JOB)
    store.addRun({ ...RUN, jobId: id, status: 'failed', resultJson: undefined })
    const last = store.addRun({ ...RUN, jobId: id, verdict: 'comments' })

    expect(store.runOfJob(id)).toEqual({ ...RUN, id: last, jobId: id, verdict: 'comments' })
    expect(store.runOfJob(id + 1)).toBeUndefined()
    store.close()
  })

  it('finds a job by its id', async () => {
    const store = await openHistoryStore(fresh())
    const id = store.addJob(JOB)
    expect(store.job(id)).toEqual({ ...JOB, id })
    expect(store.job(id + 1)).toBeUndefined()
    store.close()
  })

  it('lists when the jobs created since a time were created, but not the ones dropped before they ran', async () => {
    const store = await openHistoryStore(fresh())
    store.addJob({ ...JOB, createdAt: '2026-10-18T11:00:00.000Z' })
    store.addJob({ ...JOB, createdAt: '2026-10-18T12:30:00.000Z' })
    expect(store.jobsCreatedSince('2026-10-18T12:00:00.000Z')).toEqual(['2026-10-18T12:30:00.000Z'])
    store.close()
  })

  it('runs work in one transaction and rolls it back on an error', async () => {
    const store = await openHistoryStore(fresh())
    expect(() =>
      store.transaction(() => {
        store.addJob(JOB)
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(store.transaction(() => store.addJob(JOB))).toBe(1)
    expect(store.jobs({})).toHaveLength(1)
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

describe('HistoryStore queries', () => {
  const at = (hour: number) => `2026-10-18T${String(hour).padStart(2, '0')}:00:00.000Z`

  it('runs filters by repo, number and since, newest first, with total before the limit', async () => {
    const store = await openHistoryStore(fresh())
    store.addRun({ ...RUN, startedAt: at(1) })
    store.addRun({ ...RUN, startedAt: at(3) })
    store.addRun({ ...RUN, number: 4, startedAt: at(4) })
    store.addRun({ ...RUN, repo: 'acme/other', startedAt: at(5) })

    const all = store.runs({ limit: 2 })
    const shop = store.runs({ repo: 'Acme/Shop', number: 3, since: at(2) })

    expect(all.total).toBe(4)
    expect(all.runs.map((run) => run.startedAt)).toEqual([at(5), at(4)])
    expect(shop).toEqual({ runs: [expect.objectContaining({ startedAt: at(3) })], total: 1 })
    store.close()
  })

  it('runs never return resultJson', async () => {
    const store = await openHistoryStore(fresh())
    store.addRun(RUN)

    expect(store.runs({}).runs[0]).not.toHaveProperty('resultJson')
    store.close()
  })

  it('feedbackDue lists pulls with findings or published runs with findings, oldest observation first', async () => {
    const store = await openHistoryStore(fresh())
    store.addRun({ ...RUN, number: 7 })
    store.addRun({ ...RUN, number: 8, findings: 0 })
    store.addRun({ ...RUN, number: 9, status: 'dry-run' })
    store.observeFeedback({
      repo: 'acme/shop',
      number: 3,
      pullState: 'open',
      observedAt: at(1),
      source: 'watch',
      threads: [],
    })
    store.recordPublished([
      {
        repo: 'acme/shop',
        number: 3,
        commitSha: 'a'.repeat(40),
        fingerprint: 'a.ts:x',
        file: 'a.ts',
        line: 1,
        title: 'X',
        severity: 'P2',
        confidence: 80,
        publishedAt: at(1),
      },
    ])

    expect(store.feedbackDue({}, at(2))).toEqual([
      { repo: 'acme/shop', number: 7 },
      { repo: 'acme/shop', number: 3 },
    ])
    expect(store.feedbackDue({}, at(2), 1)).toEqual([{ repo: 'acme/shop', number: 7 }])
    expect(store.feedbackDue({ repos: ['acme/other'] }, at(2))).toEqual([])
    expect(store.feedbackDue({ repo: 'acme/shop', number: 3 }, at(1))).toEqual([])
    store.close()
  })
})

describe('HistoryStore prune', () => {
  const OLD_AT = '2026-01-01T00:00:00.000Z'
  const CUT = '2026-06-01T00:00:00.000Z'

  async function filled(watchedHead = 'b'.repeat(40)) {
    const store = await openHistoryStore(fresh())
    const oldJob = store.addJob({ ...JOB, status: 'done', finishedAt: OLD_AT, createdAt: OLD_AT })
    store.addJob({ ...JOB, number: 4, status: 'queued', createdAt: OLD_AT })
    store.addJob({ ...JOB, number: 5, status: 'running', createdAt: OLD_AT })
    const citedJob = store.addJob({ ...JOB, number: 6, status: 'failed', finishedAt: OLD_AT })
    const oldRun = store.addRun({ ...RUN, jobId: oldJob, startedAt: OLD_AT, finishedAt: OLD_AT })
    store.addRun({ ...RUN, jobId: citedJob })
    store.recordPublished([
      {
        repo: 'acme/shop',
        number: 3,
        commitSha: 'a'.repeat(40),
        fingerprint: 'a.ts:x',
        file: 'a.ts',
        line: 1,
        title: 'X',
        severity: 'P2',
        confidence: 80,
        runId: oldRun,
        publishedAt: OLD_AT,
      },
    ])
    store.observeFeedback({
      repo: 'acme/shop',
      number: 3,
      pullState: 'open',
      observedAt: OLD_AT,
      source: 'watch',
      threads: [],
    })
    store.saveRepo({ repo: 'acme/shop', checkedAt: OLD_AT })
    store.savePull({
      repo: 'acme/shop',
      number: 3,
      headSha: watchedHead,
      headSeenAt: OLD_AT,
      eligible: true,
      state: 'open',
    })
    store.setPause({ until: OLD_AT, reason: 'usage-limit', streak: 1 })
    return store
  }

  it('prune removes old runs, findings with their signals and finished jobs no run cites', async () => {
    const store = await filled()

    const counts = store.prune(CUT)

    expect(counts).toEqual({ runs: 1, findings: 1, jobs: 1, vacuumed: true })
    expect(store.runs({}).total).toBe(1)
    expect(store.findings({})).toEqual([])
    expect(store.jobs({}).map((job) => job.number)).toEqual([4, 5, 6])
    store.close()
  })

  it('prune keeps queued and running jobs and the watch state', async () => {
    const store = await filled()

    store.prune('2099-01-01T00:00:00.000Z')

    expect(store.jobs({ status: ['queued', 'running'] }).map((job) => job.number)).toEqual([4, 5])
    expect(store.repo('acme/shop')).toEqual({ repo: 'acme/shop', checkedAt: OLD_AT })
    expect(store.pulls('acme/shop')).toHaveLength(1)
    expect(store.pause()).toEqual({ until: OLD_AT, reason: 'usage-limit', streak: 1 })
    store.close()
  })

  it('prune keeps the finished job of the head an open pull request is still at', async () => {
    const store = await filled('a'.repeat(40))

    expect(store.prune(CUT)).toMatchObject({ runs: 1, findings: 1, jobs: 0 })
    expect(store.jobs({}).map((job) => job.number)).toEqual([3, 4, 5, 6])
    store.close()
  })

  it('prune removes nothing newer than the cut', async () => {
    const store = await filled()

    expect(store.prune('2025-01-01T00:00:00.000Z')).toEqual({
      runs: 0,
      findings: 0,
      jobs: 0,
      vacuumed: true,
    })
    store.close()
  })
})
