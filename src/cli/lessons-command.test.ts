import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { memoryFiles } from '../../test/support/memory-files.js'
import { nodeFileSystem } from '../config/local-files.js'
import type { ReviewPrompt } from '../providers/types.js'
import type { Miss } from '../publish/misses.js'
import { openHistoryStore } from '../store/history-store.js'
import type { HistoryStore } from '../store/history-store.js'
import { UsageError } from './errors.js'
import { runLessons } from './lessons-command.js'
import type { LessonsCommand, LessonsCommandDeps } from './lessons-command.js'
import type { ProviderOptions } from './provider-choice.js'

const root = mkdtempSync(join(tmpdir(), 'phada-lessons-command-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let dirs = 0

const NOW = new Date('2026-11-04T10:00:00.000Z')
const LIST: LessonsCommand = { all: false, refresh: false, format: 'text' }

function miss(threadId: string, overrides: Partial<Miss> = {}): Miss {
  return {
    key: threadId,
    origin: 'person',
    seen: 'missed-live',
    repo: 'acme/shop',
    number: 3,
    commitSha: 'c'.repeat(40),
    threadId,
    threadUrl: `https://github.com/acme/shop/pull/3#${threadId}`,
    file: 'src/api/orders.ts',
    line: 20,
    author: 'alice',
    role: 'member',
    body: `Comment ${threadId}.`,
    createdAt: '2026-10-20T10:00:00Z',
    ...overrides,
  }
}

function harness(config: Record<string, string> = {}, answer: unknown = { lessons: [] }) {
  const data = join(root, `d${++dirs}`)
  const out: string[] = []
  const err: string[] = []
  const providers: { name: string; options: ProviderOptions }[] = []
  const prompts: ReviewPrompt[] = []
  const deps: LessonsCommandDeps = {
    env: { PHADA_CONFIG_HOME: '/cfg', PHADA_DATA_HOME: data },
    home: '/home/u',
    files: { ...memoryFiles(config), exists: (path) => nodeFileSystem.exists(path) },
    stdout: { write: (text: string) => out.push(text) },
    stderr: { write: (text: string) => err.push(text) },
    clock: () => NOW,
    openHistoryStore: (path) => openHistoryStore(path),
    createProvider: (name, options) => {
      providers.push({ name, options })
      return {
        id: name,
        review: async (prompt) => {
          prompts.push(prompt)
          return { text: JSON.stringify(answer), durationMs: 1 }
        },
      }
    },
  }
  const seed = async (seeding: (store: HistoryStore) => void) => {
    const store = await openHistoryStore(join(data, 'history.sqlite'))
    try {
      seeding(store)
    } finally {
      store.close()
    }
  }
  return { deps, out, err, providers, prompts, seed }
}

describe('runLessons', () => {
  it('says there is nothing yet when the history does not exist', async () => {
    const { deps, out } = harness()

    await runLessons(LIST, deps)

    expect(out.join('')).toBe(
      'No lessons in the history yet; phada lessons --refresh proposes them from the misses.\n',
    )
  })

  it('lists the pending lessons, the ones with more misses first', async () => {
    const { deps, out, seed } = harness()
    await seed((store) => {
      store.recordMisses([miss('A'), miss('B'), miss('C')], '2026-11-01T00:00:00Z')
      const [a, b, c] = store.misses({}).misses.map(({ id }) => id)
      store.recordLessons(
        {
          repo: 'acme/shop',
          created: [
            { rule: 'One miss.', scope: ['src/**'], missIds: [a ?? 0] },
            { rule: 'Two misses.', scope: ['src/**'], missIds: [b ?? 0, c ?? 0] },
          ],
          attached: [],
        },
        '2026-11-02T00:00:00Z',
      )
    })

    await runLessons(LIST, deps)

    const text = out.join('')
    expect(text.indexOf('Two misses.')).toBeLessThan(text.indexOf('One miss.'))
    expect(text).toContain('https://github.com/acme/shop/pull/3#B')
  })

  it('proposes lessons with the provider and model of the config of that repository', async () => {
    const { deps, out, err, providers, prompts, seed } = harness(
      {
        '/cfg/config.yml': 'provider: claude\n',
        '/cfg/repos/acme/shop/config.yml':
          'provider: codex\nmodel: gpt-b\nrules:\n  - id: no-console\n    scope: ["src/**"]\n    rule: Do not log with console.\n',
      },
      {
        lessons: [{ rule: 'Validate bodies.', scope: ['src/api/**'], misses: [1], extends: null }],
      },
    )
    await seed((store) => store.recordMisses([miss('A')], '2026-11-01T00:00:00Z'))

    await runLessons({ ...LIST, refresh: true, repo: { owner: 'Acme', repo: 'Shop' } }, deps)

    expect(providers).toEqual([{ name: 'codex', options: { model: 'gpt-b' } }])
    expect(prompts[0]?.data).toContain('Do not log with console.')
    expect(err.join('')).toContain('acme/shop')
    expect(out.join('')).toContain('Validate bodies.')
  })

  it('refuses --refresh when the history is off', async () => {
    const { deps } = harness({ '/cfg/config.yml': 'history: false\n' })

    await expect(runLessons({ ...LIST, refresh: true }, deps)).rejects.toThrow(
      new UsageError('--refresh saves to the history; remove history: false from your config.'),
    )
  })
})
