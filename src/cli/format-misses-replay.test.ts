import { describe, expect, it } from 'vitest'
import type { MissesReplay } from '../app/replay-misses.js'
import type { MissRecord } from '../store/history-store.js'
import { formatMissesReplayJson, formatMissesReplayText } from './format-misses-replay.js'

function miss(id: number, overrides: Partial<MissRecord> = {}): MissRecord {
  return {
    id,
    key: `T${id}`,
    origin: 'person',
    seen: 'missed-live',
    repo: 'acme/shop',
    number: 3,
    reviewedSha: 'a'.repeat(40),
    commitSha: 'c'.repeat(40),
    threadId: `T${id}`,
    threadUrl: `https://github.com/acme/shop/pull/3#discussion_r${id}`,
    file: 'src/shop.ts',
    startLine: 20,
    line: 22,
    author: 'alice',
    role: 'member',
    body: 'This loses the balance\nwhen the order fails.',
    createdAt: '2026-10-20T11:00:00Z',
    harvestedAt: '2026-10-22T12:00:00.000Z',
    state: 'open',
    ...overrides,
  }
}

const REPLAY: MissesReplay = {
  version: '0.12.0',
  misses: [
    { miss: miss(1), outcome: 'caught', runId: 40 },
    {
      miss: miss(2, { startLine: undefined, line: 8, body: 'Total is wrong.' }),
      outcome: 'missed',
    },
    {
      miss: miss(3, { number: 4, threadUrl: '' }),
      outcome: 'failed',
      error: 'The AI CLI is not logged in.',
    },
  ],
  tally: { version: '0.12.0', caught: 1, replayed: 2 },
  earlier: { version: '0.11.1', caught: 0, replayed: 2 },
  left: 1,
}

describe('formatMissesReplayText', () => {
  it('shows each miss with its outcome, the total and the earlier version', () => {
    expect(formatMissesReplayText(REPLAY)).toBe(
      [
        '   1  acme/shop#3  src/shop.ts:20-22  alice (member)  person · missed-live  caught',
        '      This loses the balance',
        '      https://github.com/acme/shop/pull/3#discussion_r1',
        '',
        '   2  acme/shop#3  src/shop.ts:8  alice (member)  person · missed-live  missed',
        '      Total is wrong.',
        '      https://github.com/acme/shop/pull/3#discussion_r2',
        '',
        '   3  acme/shop#4  src/shop.ts:20-22  alice (member)  person · missed-live  not replayed',
        '      This loses the balance',
        '',
        '1 of 2 caught in 0.12.0.',
        'Before: 0 of 2 caught in 0.11.1.',
        '1 miss not replayed: its review failed.',
        'Stopped with 1 miss left to replay.',
        '',
      ].join('\n'),
    )
  })

  it('says when there is nothing to replay', () => {
    expect(
      formatMissesReplayText({
        version: '0.12.0',
        misses: [],
        tally: { version: '0.12.0', caught: 0, replayed: 0 },
        left: 0,
      }),
    ).toBe('No open misses to replay.\n')
  })
})

describe('formatMissesReplayJson', () => {
  it('keeps the outcome, the run and the tallies', () => {
    const json = JSON.parse(formatMissesReplayJson(REPLAY)) as Record<string, unknown>

    expect(json).toMatchObject({
      schemaVersion: 1,
      version: '0.12.0',
      caught: 1,
      replayed: 2,
      failed: 1,
      left: 1,
      earlier: { version: '0.11.1', caught: 0, replayed: 2 },
    })
    expect(json.misses).toMatchObject([
      { id: 1, outcome: 'caught', runId: 40, error: null, file: 'src/shop.ts', startLine: 20 },
      { id: 2, outcome: 'missed', runId: null, error: null, startLine: null },
      { id: 3, outcome: 'failed', runId: null, error: 'The AI CLI is not logged in.' },
    ])
    expect(JSON.parse(formatMissesReplayJson({ ...REPLAY, earlier: undefined })).earlier).toBeNull()
  })
})
