import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { HISTORY_MIGRATIONS } from './history-migrations.js'
import { openHistoryStore } from './history-store.js'
import type { HistoryStore, RunRecord } from './history-store.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-harvest-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let files = 0
const fresh = () => join(dir, `h${++files}`, 'history.sqlite')

const RUN: RunRecord = {
  source: 'watch',
  repo: 'acme/shop',
  number: 3,
  headSha: 'a'.repeat(40),
  startedAt: '2026-10-20T09:00:00.000Z',
  finishedAt: '2026-10-20T09:30:00.000Z',
  status: 'published',
  aiCalled: true,
}

async function withStore(test: (store: HistoryStore) => void, path = fresh()): Promise<void> {
  const store = await openHistoryStore(path)
  try {
    test(store)
  } finally {
    store.close()
  }
}

describe('HistoryStore lesson harvest', () => {
  it('keeps one cursor per repository, the last saved wins', () =>
    withStore((store) => {
      expect(store.lessonHarvest('acme/shop')).toBeUndefined()

      store.saveLessonHarvest({
        repo: 'Acme/Shop',
        closedSince: '2026-10-01T00:00:00Z',
        harvestedAt: '2026-11-01T00:00:00.000Z',
      })
      store.saveLessonHarvest({
        repo: 'acme/shop',
        closedSince: '2026-10-30T00:00:00Z',
        harvestedAt: '2026-11-08T00:00:00.000Z',
      })

      expect(store.lessonHarvest('ACME/shop')).toEqual({
        repo: 'acme/shop',
        closedSince: '2026-10-30T00:00:00Z',
        harvestedAt: '2026-11-08T00:00:00.000Z',
      })
      expect(store.lessonHarvest('acme/web')).toBeUndefined()
    }))

  it('finds the cursor of a repository saved as typed in mixed case', () =>
    withStore((store) => {
      store.saveLessonHarvest({
        repo: 'Acme/Web',
        closedSince: '2026-10-01T00:00:00Z',
        harvestedAt: '2026-11-01T00:00:00.000Z',
      })

      expect(store.lessonHarvest('Acme/Web')?.closedSince).toBe('2026-10-01T00:00:00Z')
    }))

  it('names each repository with a run once, in order', () =>
    withStore((store) => {
      store.addRun({ ...RUN, repo: 'acme/web' })
      store.addRun(RUN)
      store.addRun({ ...RUN, number: 4 })
      store.addRun({ ...RUN, source: 'local', repo: 'acme/cli', branch: 'main' })

      expect(store.runRepos()).toEqual(['acme/cli', 'acme/shop', 'acme/web'])
    }))

  it('migrates a version 9 file to the latest version with the cursor table', async () => {
    const path = fresh()
    const v9 = await openHistoryStore(path, { migrations: HISTORY_MIGRATIONS.slice(0, 9) })
    v9.addRun(RUN)
    v9.close()

    await withStore((store) => {
      expect(store.runRepos()).toEqual(['acme/shop'])
      store.saveLessonHarvest({
        repo: 'acme/shop',
        closedSince: '2026-10-30T00:00:00Z',
        harvestedAt: '2026-11-08T00:00:00.000Z',
      })
      expect(store.lessonHarvest('acme/shop')?.closedSince).toBe('2026-10-30T00:00:00Z')
    }, path)
  })
})
