import { mkdir, open, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

export const LOCK_POLL_MS = 200

export class MirrorLockTimeoutError extends Error {
  override readonly name = 'MirrorLockTimeoutError'
  readonly path: string

  constructor(path: string) {
    super(`${path} is held by another process`)
    this.path = path
  }
}

export interface MirrorLockOptions {
  timeoutMs: number
  staleMs: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export async function withMirrorLock<T>(
  lockPath: string,
  options: MirrorLockOptions,
  work: () => Promise<T>,
): Promise<T> {
  await acquire(lockPath, options)
  try {
    return await work()
  } finally {
    await rm(lockPath, { force: true })
  }
}

async function acquire(lockPath: string, options: MirrorLockOptions): Promise<void> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)))
  await mkdir(dirname(lockPath), { recursive: true })
  const deadline = now() + options.timeoutMs
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(new Date(now()).toISOString())
      await handle.close()
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const held = await stat(lockPath).catch(() => undefined)
    if (held !== undefined && now() - held.mtimeMs > options.staleMs) {
      await rm(lockPath, { force: true })
      continue
    }
    if (now() >= deadline) throw new MirrorLockTimeoutError(lockPath)
    await sleep(LOCK_POLL_MS)
  }
}
