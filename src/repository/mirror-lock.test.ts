import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MirrorLockTimeoutError, withMirrorLock } from './mirror-lock.js'

const dir = mkdtempSync(join(tmpdir(), 'phada-lock-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const OPTIONS = { timeoutMs: 5_000, staleMs: 60_000 }

describe('withMirrorLock', () => {
  it('holds the lock while the work runs and removes it after', async () => {
    const lock = join(dir, 'a', 'repo.git.lock')
    const seen = await withMirrorLock(lock, OPTIONS, async () => existsSync(lock))

    expect(seen).toBe(true)
    expect(existsSync(lock)).toBe(false)
  })

  it('removes the lock and rethrows when the work fails', async () => {
    const lock = join(dir, 'b.lock')
    await expect(
      withMirrorLock(lock, OPTIONS, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(existsSync(lock)).toBe(false)
  })

  it('runs two holders of the same lock one after the other', async () => {
    const lock = join(dir, 'c.lock')
    const events: string[] = []
    const work = (name: string) => async () => {
      events.push(`${name} start`)
      await new Promise((resolve) => setTimeout(resolve, 30))
      events.push(`${name} end`)
    }

    await Promise.all([
      withMirrorLock(lock, OPTIONS, work('one')),
      withMirrorLock(lock, OPTIONS, work('two')),
    ])

    expect(events).toEqual(['one start', 'one end', 'two start', 'two end'])
  })

  it('takes over a lock older than the stale age', async () => {
    const lock = join(dir, 'd.lock')
    writeFileSync(lock, 'old')
    const old = new Date(Date.now() - 120_000)
    utimesSync(lock, old, old)

    expect(await withMirrorLock(lock, OPTIONS, async () => 'ran')).toBe('ran')
  })

  it('gives up with MirrorLockTimeoutError when a fresh lock is held past the timeout', async () => {
    const lock = join(dir, 'e.lock')
    writeFileSync(lock, 'busy')

    const error = await withMirrorLock(
      lock,
      { timeoutMs: 50, staleMs: 60_000 },
      async () => 1,
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(MirrorLockTimeoutError)
    expect(existsSync(lock)).toBe(true)
  })
})
