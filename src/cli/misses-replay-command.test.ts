import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { nodeFileSystem } from '../config/local-files.js'
import type { Miss } from '../publish/misses.js'
import type { MissReplayRun } from '../app/replay-misses.js'
import { openHistoryStore } from '../store/history-store.js'
import type { HistoryStore } from '../store/history-store.js'
import { MissingGitHubTokenError, UsageError } from './errors.js'
import { runMissesReplay } from './misses-replay-command.js'
import type { MissesReplayDeps } from './misses-replay-command.js'

const root = mkdtempSync(join(tmpdir(), 'phada-misses-replay-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let dirs = 0

const NOW = new Date('2026-11-03T12:00:00.000Z')
const COMMIT = 'c'.repeat(40)

function miss(threadId: string, overrides: Partial<Miss> = {}): Miss {
  return {
    repo: 'acme/shop',
    number: 3,
    reviewedSha: 'a'.repeat(40),
    commitSha: COMMIT,
    threadId,
    threadUrl: '',
    file: 'src/shop.ts',
    line: 20,
    author: 'alice',
    role: 'member',
    body: 'This loses the balance.',
    createdAt: '2026-10-20T11:00:00Z',
    ...overrides,
  }
}

function harness(
  options: {
    config?: string
    token?: boolean
    replays?: Record<number, MissReplayRun | Error>
  } = {},
) {
  const data = join(root, `d${++dirs}`)
  const out: string[] = []
  const err: string[] = []
  const tokens: string[] = []
  const replayed: string[] = []
  const signals: (() => void)[] = []
  const aborts: number[] = []
  const config = memoryFiles(
    options.config === undefined ? {} : { '/cfg/config.yml': options.config },
  )
  const deps: MissesReplayDeps = {
    env: {
      PHADA_CONFIG_HOME: '/cfg',
      PHADA_DATA_HOME: data,
      ...(options.token === false ? {} : { GITHUB_TOKEN: 'ghp_test' }),
    },
    ghToken: async () => undefined,
    home: '/home/u',
    version: '0.12.0',
    files: { ...config, exists: (path) => nodeFileSystem.exists(path) },
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
    clock: () => NOW,
    openHistoryStore: (path) => openHistoryStore(path),
    fetchReviewState: () => Promise.reject(new Error('not read')),
    onSignal: (handler) => signals.push(handler),
    abort: (code) => aborts.push(code),
  }
  const replayer = (token: string) => {
    tokens.push(token)
    return async ({ repo, number }: { repo: string; number: number }, sha: string) => {
      replayed.push(`${repo}#${number}@${sha.slice(0, 7)}`)
      const run = options.replays?.[number] ?? { findings: [] }
      if (run instanceof Error) throw run
      return run
    }
  }
  const file = join(data, 'history.sqlite')
  const seed = async (seeding: (store: HistoryStore) => void) => {
    const store = await openHistoryStore(file)
    seeding(store)
    store.close()
  }
  return {
    deps,
    replayer,
    seed,
    file,
    tokens,
    replayed,
    signals,
    aborts,
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  }
}

const COMMAND = { format: 'text' as const }

describe('runMissesReplay', () => {
  it('announces each review before it runs and prints the outcome of each miss', async () => {
    const h = harness({
      replays: { 3: { findings: [{ file: 'src/shop.ts', line: 22 }] }, 4: { findings: [] } },
    })
    await h.seed((store) => {
      store.recordMisses([miss('T1'), miss('T2', { line: 70 }), miss('T3', { number: 4 })], 'x')
    })

    expect(await runMissesReplay(COMMAND, h.deps, h.replayer)).toBe(0)

    expect(h.tokens).toEqual(['ghp_test'])
    expect(h.replayed).toEqual(['acme/shop#3@ccccccc', 'acme/shop#4@ccccccc'])
    expect(h.stderr()).toBe(
      [
        'Replaying 3 open misses: 2 reviews with your AI, one per pull request and commit.',
        '[1/2] Reviewing acme/shop#3 at ccccccc again for 2 misses…',
        '[2/2] Reviewing acme/shop#4 at ccccccc again for 1 miss…',
        '',
      ].join('\n'),
    )
    expect(h.stdout()).toContain('acme/shop#3  src/shop.ts:20  alice (member)  caught')
    expect(h.stdout()).toContain('acme/shop#3  src/shop.ts:70  alice (member)  missed')
    expect(h.stdout()).toContain('1 of 3 caught in 0.12.0.\n')
  })

  it('warns about a failed review, goes on and fails only when nothing was replayed', async () => {
    const h = harness({ replays: { 3: new Error('The AI CLI is not logged in.') } })
    await h.seed((store) => store.recordMisses([miss('T1')], 'x'))

    expect(await runMissesReplay({ format: 'json' }, h.deps, h.replayer)).toBe(1)

    expect(h.stderr()).toContain(
      'Warning: acme/shop#3 at ccccccc was not replayed: The AI CLI is not logged in.\n',
    )
    expect(JSON.parse(h.stdout())).toMatchObject({ failed: 1, replayed: 0 })
  })

  it('stops after the current review on Ctrl-C and aborts on the second', async () => {
    const h = harness()
    await h.seed((store) => store.recordMisses([miss('T1'), miss('T2', { number: 4 })], 'x'))
    const replayer = (token: string) => {
      const replay = h.replayer(token)
      return async (pull: { repo: string; number: number }, sha: string) => {
        h.signals.forEach((handler) => handler())
        return replay(pull, sha)
      }
    }

    expect(await runMissesReplay(COMMAND, h.deps, replayer)).toBe(0)

    expect(h.replayed).toEqual(['acme/shop#3@ccccccc'])
    expect(h.stderr()).toContain('Stopping after the current review (Ctrl-C again to abort).\n')
    expect(h.stdout()).toContain('Stopped with 1 miss left to replay.\n')
    h.signals.forEach((handler) => handler())
    expect(h.aborts).toEqual([130])
  })

  it('says there is nothing to replay without a history', async () => {
    const h = harness()

    expect(await runMissesReplay(COMMAND, h.deps, h.replayer)).toBe(0)

    expect(h.stdout()).toBe('No open misses to replay.\n')
    expect(h.replayed).toEqual([])
  })

  it('refuses when the history is off and needs a GitHub token', async () => {
    await expect(
      runMissesReplay(COMMAND, harness({ config: 'history: false\n' }).deps, () => {
        throw new Error('not reached')
      }),
    ).rejects.toThrow(
      new UsageError('--replay saves to the history; remove history: false from your config.'),
    )
    await expect(
      runMissesReplay(COMMAND, harness({ token: false }).deps, () => {
        throw new Error('not reached')
      }),
    ).rejects.toBeInstanceOf(MissingGitHubTokenError)
  })
})
