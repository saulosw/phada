import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { HISTORY_MIGRATIONS } from './history-migrations.js'
import { openHistoryStore } from './history-store.js'
import type { ClassifiedReply, HistoryStore } from './history-store.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-replies-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let files = 0
const fresh = () => join(dir, `h${++files}`, 'history.sqlite')

const T1 = '2026-11-01T10:00:00.000Z'
const T2 = '2026-11-02T10:00:00.000Z'

function reply(commentId: string, overrides: Partial<ClassifiedReply> = {}): ClassifiedReply {
  return {
    repo: 'acme/shop',
    number: 3,
    threadId: 'PRRT_1',
    commentId,
    author: 'alice',
    kind: 'question',
    answered: true,
    answerId: `A-${commentId}`,
    answerUrl: `https://github.com/acme/shop/pull/3#discussion_${commentId}`,
    resolved: false,
    source: 'manual',
    observedAt: T1,
    ...overrides,
  }
}

async function withStore(test: (store: HistoryStore) => void, path = fresh()): Promise<void> {
  const store = await openHistoryStore(path)
  try {
    test(store)
  } finally {
    store.close()
  }
}

describe('HistoryStore replies', () => {
  it('records classified replies and reads them back', () =>
    withStore((store) => {
      const question = reply('C2')
      const ack = reply('C3', {
        kind: 'ack',
        answered: false,
        answerId: undefined,
        answerUrl: undefined,
        source: 'watch',
      })

      store.recordReplies([question, ack])

      expect(store.replies({ repo: 'Acme/Shop', number: 3 })).toEqual([question, ack])
    }))

  it('keeps the first classification of a comment', () =>
    withStore((store) => {
      store.recordReplies([reply('C2')])
      store.recordReplies([reply('C2', { kind: 'refuted', resolved: true, observedAt: T2 })])

      expect(store.replies({}).map(({ kind, observedAt }) => ({ kind, observedAt }))).toEqual([
        { kind: 'question', observedAt: T1 },
      ])
    }))

  it('gives the comments already classified on a pull request', () =>
    withStore((store) => {
      store.recordReplies([
        reply('C2'),
        reply('C3', { threadId: 'PRRT_2' }),
        reply('C4', { number: 4 }),
        reply('C5', { repo: 'acme/web' }),
      ])

      expect(store.classifiedComments('ACME/shop', 3)).toEqual(new Set(['C2', 'C3']))
      expect(store.classifiedComments('acme/shop', 9)).toEqual(new Set())
    }))

  it('lists the replies of one thread, of a pull request or of a repository', () =>
    withStore((store) => {
      const first = reply('C2')
      const other = reply('C3', { threadId: 'PRRT_2', kind: 'disagreed' })
      const elsewhere = reply('C4', { number: 4 })
      store.recordReplies([first, other, elsewhere])

      expect(store.replies({ repo: 'acme/shop', number: 3, threadId: 'PRRT_2' })).toEqual([other])
      expect(store.replies({ repo: 'acme/shop' })).toEqual([first, other, elsewhere])
      expect(store.replies({ repo: 'acme/web' })).toEqual([])
    }))

  it('refuses a reply kind it does not know', () =>
    withStore((store) => {
      expect(() =>
        store.recordReplies([reply('C2', { kind: 'thanks' as ClassifiedReply['kind'] })]),
      ).toThrow()
      expect(store.replies({})).toEqual([])
    }))

  it('prunes the replies observed before the cut', () =>
    withStore((store) => {
      store.recordReplies([reply('C2'), reply('C3', { observedAt: T2 })])

      store.prune(T2)

      expect(store.replies({}).map(({ commentId }) => commentId)).toEqual(['C3'])
    }))

  it('keeps the pull requests with a reply due until they are cleared, oldest first', () =>
    withStore((store) => {
      store.markRepliesDue('Acme/Shop', [7, 3], T2)
      store.markRepliesDue('acme/shop', [3, 9], T1)
      store.markRepliesDue('acme/web', [1], T1)

      expect(store.repliesDue('acme/shop')).toEqual([
        { repo: 'acme/shop', number: 9, since: T1 },
        { repo: 'acme/shop', number: 3, since: T2 },
        { repo: 'acme/shop', number: 7, since: T2 },
      ])

      store.triedReplyDue('acme/shop', 3, T2)
      store.clearReplyDue('ACME/shop', 9)

      expect(store.repliesDue('acme/shop')).toEqual([
        { repo: 'acme/shop', number: 3, since: T2, triedAt: T2 },
        { repo: 'acme/shop', number: 7, since: T2 },
      ])
    }))

  it('keeps the cursor of the review comments on the repository', () =>
    withStore((store) => {
      const record = {
        repo: 'acme/shop',
        reviewCommentsSince: T1,
        reviewCommentsEtag: 'W/"r"',
        reviewCommentsLastId: 42,
      }
      store.saveRepo(record)

      expect(store.repo('acme/shop')).toEqual(record)
    }))

  it('migrates a version 8 file to one that stores replies', async () => {
    const path = fresh()
    const v8 = await openHistoryStore(path, { migrations: HISTORY_MIGRATIONS.slice(0, 8) })
    v8.close()
    const old = new DatabaseSync(path)
    old
      .prepare('insert into watched_repo (repo, pulls_etag) values (?, ?)')
      .run('acme/shop', 'W/"1"')
    old.close()

    await withStore((store) => {
      store.recordReplies([reply('C2')])
      store.markRepliesDue('acme/shop', [3], T1)
      expect(store.repo('acme/shop')).toEqual({ repo: 'acme/shop', pullsEtag: 'W/"1"' })
      expect(store.replies({})).toHaveLength(1)
      expect(store.repliesDue('acme/shop')).toHaveLength(1)
    }, path)
    const db = new DatabaseSync(path)
    const version = Number(db.prepare('pragma user_version').get()?.user_version)
    db.close()
    expect(version).toBe(HISTORY_MIGRATIONS.length)
  })
})
