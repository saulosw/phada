import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { FindingPlace, Miss } from '../publish/misses.js'
import { openHistoryStore } from '../store/history-store.js'
import type { HistoryStore } from '../store/history-store.js'
import { ReviewCancelledError } from './review-cancelled.js'
import { replayMisses } from './replay-misses.js'
import type { MissGroup, MissReplayRun, ReplayMissesDeps } from './replay-misses.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-replay-misses-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let files = 0

const T0 = '2026-10-30T10:00:00.000Z'
const T1 = '2026-11-01T10:00:00.000Z'
const T2 = '2026-11-02T10:00:00.000Z'
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

function miss(threadId: string, overrides: Partial<Miss> = {}): Miss {
  return {
    repo: 'acme/shop',
    number: 3,
    reviewedSha: SHA_A,
    commitSha: SHA_A,
    threadId,
    threadUrl: `https://github.com/acme/shop/pull/3#${threadId}`,
    file: 'src/shop.ts',
    line: 20,
    author: 'alice',
    role: 'member',
    body: 'This loses the balance.',
    createdAt: '2026-10-20T10:00:00Z',
    ...overrides,
  }
}

type Replays = Record<string, MissReplayRun | Error>

function harness(history: HistoryStore, replays: Replays, signal?: AbortSignal) {
  const calls: string[] = []
  const groups: MissGroup[] = []
  const failures: string[] = []
  const deps: ReplayMissesDeps = {
    history,
    replay: async ({ repo, number }, sha) => {
      const key = `${repo}#${number}@${sha}`
      calls.push(key)
      const found = replays[key]
      if (found === undefined) throw new Error(`unexpected replay ${key}`)
      if (found instanceof Error) throw found
      return found
    },
    now: () => T2,
    events: {
      replaying: (group) => groups.push(group),
      failed: (group, error) => failures.push(`${group.repo}#${group.number}: ${error}`),
    },
    ...(signal === undefined ? {} : { signal }),
  }
  return { deps, calls, groups, failures }
}

async function withHistory(test: (history: HistoryStore) => Promise<void>): Promise<void> {
  const history = await openHistoryStore(join(dir, `h${++files}`, 'history.sqlite'))
  try {
    await test(history)
  } finally {
    history.close()
  }
}

const found = (...places: FindingPlace[]): MissReplayRun => ({ findings: places })

function outcomes(result: Awaited<ReturnType<typeof replayMisses>>) {
  return result.misses.map((item) => [item.miss.threadId, item.outcome])
}

describe('replayMisses', () => {
  it('reviews each pull request and commit once and decides each miss by the 5-line window', () =>
    withHistory(async (history) => {
      history.recordMisses(
        [
          miss('T1', { line: 20 }),
          miss('T2', { line: 60 }),
          miss('T3', { commitSha: SHA_B, file: 'src/cart.ts', line: 8 }),
          miss('T4', { repo: 'acme/api', number: 9, line: 5 }),
        ],
        T1,
      )
      const { deps, calls, groups } = harness(history, {
        [`acme/shop#3@${SHA_A}`]: found({ file: 'src/shop.ts', line: 24 }),
        [`acme/shop#3@${SHA_B}`]: found({ file: 'src/other.ts', line: 8 }),
        [`acme/api#9@${SHA_A}`]: found({ file: 'src/shop.ts', line: 1 }),
      })

      const result = await replayMisses({ filter: {}, version: '0.12.0' }, deps)

      expect(calls).toEqual([`acme/api#9@${SHA_A}`, `acme/shop#3@${SHA_A}`, `acme/shop#3@${SHA_B}`])
      expect(groups.map(({ misses, position, groups }) => [misses, position, groups])).toEqual([
        [1, 1, 3],
        [2, 2, 3],
        [1, 3, 3],
      ])
      expect(outcomes(result)).toEqual([
        ['T4', 'caught'],
        ['T1', 'caught'],
        ['T2', 'missed'],
        ['T3', 'missed'],
      ])
      expect(result.tally).toEqual({ version: '0.12.0', caught: 2, replayed: 4 })
      expect(result.earlier).toBeUndefined()
      expect(result.left).toBe(0)
      expect(history.missReplays(result.misses.map(({ miss }) => miss.id))).toHaveLength(4)
    }))

  it('replays only the open misses of the repository asked for', () =>
    withHistory(async (history) => {
      history.recordMisses(
        [miss('T1'), miss('T2', { line: 90 }), miss('T3', { repo: 'acme/api' })],
        T1,
      )
      const dismissed = history.misses({ repo: 'acme/shop' }).misses.find((m) => m.line === 90)
      history.dismissMiss(dismissed?.id ?? 0)
      const { deps, calls } = harness(history, { [`acme/shop#3@${SHA_A}`]: found() })

      const result = await replayMisses({ filter: { repo: 'Acme/Shop' }, version: '0.12.0' }, deps)

      expect(calls).toEqual([`acme/shop#3@${SHA_A}`])
      expect(outcomes(result)).toEqual([['T1', 'missed']])
    }))

  it('overwrites the result of the same version and compares with the earlier one', () =>
    withHistory(async (history) => {
      history.recordMisses([miss('T1'), miss('T2', { line: 60 })], T1)
      const ids = history.misses({}).misses.map(({ id }) => id)
      history.recordMissReplays([
        { missId: ids[0] ?? 0, version: '0.11.0', outcome: 'caught', replayedAt: T0 },
        { missId: ids[0] ?? 0, version: '0.11.1', outcome: 'missed', replayedAt: T1 },
        { missId: ids[1] ?? 0, version: '0.11.1', outcome: 'missed', replayedAt: T1 },
      ])
      await replayMisses(
        { filter: {}, version: '0.12.0' },
        harness(history, { [`acme/shop#3@${SHA_A}`]: found() }).deps,
      )
      const runId = history.addRun({
        source: 'replay',
        repo: 'acme/shop',
        number: 3,
        headSha: SHA_A,
        startedAt: T2,
        finishedAt: T2,
        status: 'dry-run',
        aiCalled: true,
        provider: 'claude',
      })

      const again = await replayMisses(
        { filter: {}, version: '0.12.0' },
        harness(history, {
          [`acme/shop#3@${SHA_A}`]: { runId, findings: [{ file: 'src/shop.ts', line: 61 }] },
        }).deps,
      )

      expect(again.tally).toEqual({ version: '0.12.0', caught: 1, replayed: 2 })
      expect(again.earlier).toEqual({ version: '0.11.1', caught: 0, replayed: 2 })
      const current = history.missReplays(ids).filter(({ version }) => version === '0.12.0')
      expect(current.map(({ outcome }) => outcome).sort()).toEqual(['caught', 'missed'])
      expect(current.map((replay) => [replay.runId, replay.replayedAt])).toEqual([
        [runId, T2],
        [runId, T2],
      ])
    }))

  it('warns about a replay that fails and goes on with the next pull request', () =>
    withHistory(async (history) => {
      history.recordMisses([miss('T1'), miss('T2', { number: 4 })], T1)
      const { deps, failures } = harness(history, {
        [`acme/shop#3@${SHA_A}`]: new Error('The AI CLI is not logged in.'),
        [`acme/shop#4@${SHA_A}`]: found({ file: 'src/shop.ts', line: 20 }),
      })

      const result = await replayMisses({ filter: {}, version: '0.12.0' }, deps)

      expect(failures).toEqual(['acme/shop#3: The AI CLI is not logged in.'])
      expect(result.misses).toMatchObject([
        { miss: { threadId: 'T1' }, outcome: 'failed', error: 'The AI CLI is not logged in.' },
        { miss: { threadId: 'T2' }, outcome: 'caught' },
      ])
      expect(result.tally).toEqual({ version: '0.12.0', caught: 1, replayed: 1 })
      const [failed] = history.misses({ number: 3 }).misses
      expect(history.missReplays([failed?.id ?? 0])).toEqual([])
    }))

  it('counts every miss as missed when the replay reviewed nothing', () =>
    withHistory(async (history) => {
      history.recordMisses([miss('T1'), miss('T2', { line: 22 })], T1)
      const { deps } = harness(history, { [`acme/shop#3@${SHA_A}`]: { findings: [] } })

      const result = await replayMisses({ filter: {}, version: '0.12.0' }, deps)

      expect(outcomes(result)).toEqual([
        ['T1', 'missed'],
        ['T2', 'missed'],
      ])
    }))

  it('stops between pull requests once asked, keeping what was replayed', () =>
    withHistory(async (history) => {
      history.recordMisses([miss('T1'), miss('T2', { number: 4 }), miss('T3', { number: 5 })], T1)
      const stop = new AbortController()
      const { deps, calls } = harness(
        history,
        { [`acme/shop#3@${SHA_A}`]: found(), [`acme/shop#4@${SHA_A}`]: found() },
        stop.signal,
      )
      const replay = deps.replay
      deps.replay = async (pull, sha) => {
        const run = await replay(pull, sha)
        stop.abort()
        return run
      }

      const result = await replayMisses({ filter: {}, version: '0.12.0' }, deps)

      expect(calls).toEqual([`acme/shop#3@${SHA_A}`])
      expect(outcomes(result)).toEqual([['T1', 'missed']])
      expect(result.left).toBe(2)
    }))

  it('stops when the review itself is cancelled', () =>
    withHistory(async (history) => {
      history.recordMisses([miss('T1'), miss('T2', { number: 4 })], T1)
      const { deps, failures } = harness(history, {
        [`acme/shop#3@${SHA_A}`]: new ReviewCancelledError(),
      })

      const result = await replayMisses({ filter: {}, version: '0.12.0' }, deps)

      expect(failures).toEqual([])
      expect(result.misses).toEqual([])
      expect(result.left).toBe(2)
    }))
})
