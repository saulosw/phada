import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { kill, pid } from 'node:process'

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
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  const deadline = now() + options.timeoutMs
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.writeFile(`${pid} ${new Date(now()).toISOString()}`)
      await handle.close()
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const held = await stat(lockPath).catch(() => undefined)
    const holder = await readFile(lockPath, 'utf8').catch(() => '')
    if (
      held !== undefined &&
      (now() - held.mtimeMs > options.staleMs || !isAlive(Number(holder.split(' ')[0])))
    ) {
      await rm(lockPath, { force: true })
      continue
    }
    if (now() >= deadline) throw new MirrorLockTimeoutError(lockPath)
    await sleep(LOCK_POLL_MS)
  }
}

function isAlive(holder: number): boolean {
  if (!Number.isInteger(holder) || holder <= 0) return true
  try {
    kill(holder, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
