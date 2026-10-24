import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ThreadFeedback } from '../publish/feedback.js'
import { HISTORY_MIGRATIONS } from './history-migrations.js'
import { openHistoryStore } from './history-store.js'
import type {
  FeedbackObservation,
  HistoryStore,
  PublishedFinding,
  RunRecord,
} from './history-store.js'
import type { JobRecord } from '../watch/types.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-feedback-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let files = 0
const fresh = () => join(dir, `h${++files}`, 'history.sqlite')

const OLD = 'a'.repeat(40)
const T0 = '2026-10-20T10:00:00.000Z'
const T1 = '2026-10-20T11:00:00.000Z'
const T2 = '2026-10-20T12:00:00.000Z'
const T3 = '2026-10-20T13:00:00.000Z'
const FINGERPRINT = 'src/shop.ts:spendhasnoauth'

const PUBLISHED: PublishedFinding = {
  repo: 'acme/shop',
  number: 3,
  commitSha: OLD,
  fingerprint: FINGERPRINT,
  file: 'src/shop.ts',
  line: 40,
  title: 'Spend has no auth',
  severity: 'P1',
  confidence: 90,
  rule: 'auth',
  publishedAt: T0,
}

const RUN: RunRecord = {
  source: 'manual',
  repo: 'acme/shop',
  number: 3,
  headSha: OLD,
  startedAt: T0,
  finishedAt: T0,
  status: 'dry-run',
  aiCalled: true,
  provider: 'claude',
  findings: 1,
  score: 4,
  resultJson: '{"schemaVersion":1}',
}

const JOB: Omit<JobRecord, 'id'> = {
  repo: 'acme/shop',
  number: 3,
  headSha: OLD,
  status: 'done',
  attempts: 1,
  notBefore: T0,
  createdAt: T0,
  finishedAt: T0,
}

function thread(overrides: Partial<ThreadFeedback> = {}): ThreadFeedback {
  return {
    threadId: 'T1',
    fingerprint: FINGERPRINT,
    url: 'https://github.com/acme/shop/pull/3#discussion_r1',
    file: 'src/shop.ts',
    line: 44,
    title: 'Spend has no auth',
    severity: 'P1',
    commitSha: OLD,
    outdated: false,
    destination: 'open',
    signals: [],
    ...overrides,
  }
}

function observation(
  threads: ThreadFeedback[],
  overrides: Partial<FeedbackObservation> = {},
): FeedbackObservation {
  return {
    repo: 'acme/shop',
    number: 3,
    pullState: 'open',
    observedAt: T1,
    source: 'watch',
    threads,
    ...overrides,
  }
}

async function withStore(test: (store: HistoryStore) => void): Promise<void> {
  const store = await openHistoryStore(fresh())
  try {
    test(store)
  } finally {
    store.close()
  }
}

describe('history migration 2', () => {
  it('migrates a version 1 file and keeps its rows', async () => {
    const path = fresh()
    const v1 = await openHistoryStore(path, { migrations: HISTORY_MIGRATIONS.slice(0, 1) })
    v1.addRun(RUN)
    v1.addJob(JOB)
    v1.savePull({
      repo: 'acme/shop',
      number: 3,
      headSha: OLD,
      headSeenAt: T0,
      eligible: true,
      state: 'open',
    })
    const before = v1.status()
    v1.close()

    const store = await openHistoryStore(path)
    const after = store.status()
    store.close()

    const db = new DatabaseSync(path)
    const version = Number(db.prepare('pragma user_version').get()?.user_version)
    const tables = db
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((row) => row.name)
    db.close()
    expect(version).toBe(HISTORY_MIGRATIONS.length)
    expect(tables).toEqual(expect.arrayContaining(['feedback_pull', 'finding', 'signal']))
    expect(after).toEqual(before)
  })
})

describe('HistoryStore feedback', () => {
  it('records published findings without a thread', () =>
    withStore((store) => {
      store.recordPublished([PUBLISHED])

      expect(store.findings({})).toEqual([
        {
          id: expect.any(Number),
          ...PUBLISHED,
          outdated: false,
          signals: [],
        },
      ])
    }))

  it('adopts the published row even when the line moved', () =>
    withStore((store) => {
      store.recordPublished([PUBLISHED])

      store.observeFeedback(observation([thread()]))

      const [finding, ...rest] = store.findings({})
      expect(rest).toEqual([])
      expect(finding).toMatchObject({
        threadId: 'T1',
        threadUrl: 'https://github.com/acme/shop/pull/3#discussion_r1',
        line: 44,
        confidence: 90,
        rule: 'auth',
        publishedAt: T0,
      })
    }))

  it('does not adopt a row of another commit', () =>
    withStore((store) => {
      store.recordPublished([{ ...PUBLISHED, commitSha: 'b'.repeat(40) }])

      store.observeFeedback(observation([thread()]))

      expect(store.findings({}).map((finding) => finding.threadId)).toEqual([undefined, 'T1'])
    }))

  it('creates a row from a thread with no published row', () =>
    withStore((store) => {
      store.observeFeedback(observation([thread({ severity: undefined, commitSha: null })]))

      const [finding] = store.findings({})
      expect(finding).toEqual({
        id: expect.any(Number),
        repo: 'acme/shop',
        number: 3,
        fingerprint: FINGERPRINT,
        file: 'src/shop.ts',
        line: 44,
        title: 'Spend has no auth',
        threadId: 'T1',
        threadUrl: 'https://github.com/acme/shop/pull/3#discussion_r1',
        outdated: false,
        publishedAt: T1,
        signals: [],
      })
    }))

  it('two threads with the same fingerprint adopt two rows in id order', () =>
    withStore((store) => {
      store.recordPublished([PUBLISHED, { ...PUBLISHED, line: 80 }])

      store.observeFeedback(observation([thread({ threadId: 'T1' }), thread({ threadId: 'T2' })]))

      expect(store.findings({}).map((finding) => finding.threadId)).toEqual(['T1', 'T2'])
    }))

  it('a new signal gets observedAt and keeps it on the next observation', () =>
    withStore((store) => {
      const dismissed = thread({ destination: 'dismissed', signals: ['dismissed'] })
      store.observeFeedback(observation([dismissed]))
      store.observeFeedback(observation([dismissed], { observedAt: T2, source: 'manual' }))

      expect(store.findings({})[0]?.signals).toEqual([
        { kind: 'dismissed', source: 'watch', observedAt: T1 },
      ])
    }))

  it('a signal that stops holding gets clearedAt', () =>
    withStore((store) => {
      store.observeFeedback(
        observation([thread({ destination: 'dismissed', signals: ['dismissed'] })]),
      )
      store.observeFeedback(observation([thread()], { observedAt: T2 }))

      expect(store.findings({})[0]?.signals).toEqual([
        { kind: 'dismissed', source: 'watch', observedAt: T1, clearedAt: T2 },
      ])
    }))

  it('a signal that comes back opens a new row', () =>
    withStore((store) => {
      const dismissed = thread({ destination: 'dismissed', signals: ['dismissed'] })
      store.observeFeedback(observation([dismissed]))
      store.observeFeedback(observation([thread()], { observedAt: T2 }))
      store.observeFeedback(observation([dismissed], { observedAt: T3 }))

      expect(store.findings({})[0]?.signals).toEqual([
        { kind: 'dismissed', source: 'watch', observedAt: T1, clearedAt: T2 },
        { kind: 'dismissed', source: 'watch', observedAt: T3 },
      ])
    }))

  it('reopened pull request clears ignored and is due again', () =>
    withStore((store) => {
      store.observeFeedback(
        observation([thread({ destination: 'ignored', signals: ['ignored'] })], {
          pullState: 'closed',
        }),
      )
      expect(store.feedbackDue({}, T3)).toEqual([])

      store.observeFeedback(observation([thread()], { observedAt: T2 }))

      expect(store.findings({})[0]?.signals).toEqual([
        { kind: 'ignored', source: 'watch', observedAt: T1, clearedAt: T2 },
      ])
      expect(store.feedbackDue({}, T3)).toEqual([{ repo: 'acme/shop', number: 3 }])
    }))

  it('a pull request last seen closed is due again once the watch lists it open', () =>
    withStore((store) => {
      store.observeFeedback(
        observation([thread({ destination: 'ignored', signals: ['ignored'] })], {
          pullState: 'closed',
        }),
      )
      const pull = {
        repo: 'acme/shop',
        number: 3,
        headSha: OLD,
        headSeenAt: T0,
        eligible: true,
        state: 'gone' as const,
      }
      store.savePull(pull)
      expect(store.feedbackDue({}, T3)).toEqual([])

      store.savePull({ ...pull, state: 'open' })

      expect(store.feedbackDue({}, T3)).toEqual([{ repo: 'acme/shop', number: 3 }])
      expect(store.feedbackDue({}, T1)).toEqual([])
    }))

  it('a thread missing from a later observation keeps its signals', () =>
    withStore((store) => {
      store.observeFeedback(
        observation([thread({ destination: 'dismissed', signals: ['dismissed'] })]),
      )
      store.observeFeedback(observation([], { observedAt: T2 }))

      expect(store.findings({})[0]?.signals).toEqual([
        { kind: 'dismissed', source: 'watch', observedAt: T1 },
      ])
    }))

  it('keeps the outdated flag of the latest observation', () =>
    withStore((store) => {
      store.observeFeedback(observation([thread({ outdated: true })]))

      expect(store.findings({})[0]?.outdated).toBe(true)
    }))

  it('observation is atomic', () =>
    withStore((store) => {
      const broken = thread({ threadId: 'T2', file: undefined as unknown as string })

      expect(() => store.observeFeedback(observation([thread(), broken]))).toThrow()

      expect(store.findings({})).toEqual([])
      expect(store.feedbackDue({}, T3)).toEqual([])
    }))
})
