import { randomUUID } from 'node:crypto'
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
  const content = await acquire(lockPath, options)
  try {
    return await work()
  } finally {
    await removeIfHeld(lockPath, content)
  }
}

async function acquire(lockPath: string, options: MirrorLockOptions): Promise<string> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)))
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  const deadline = now() + options.timeoutMs
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx')
      const content = `${pid} ${new Date(now()).toISOString()} ${randomUUID()}`
      await handle.writeFile(content)
      await handle.close()
      return content
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const held = await stat(lockPath).catch(() => undefined)
    const holder = await readFile(lockPath, 'utf8').catch(() => '')
    if (
      held !== undefined &&
      (now() - held.mtimeMs > options.staleMs || !isAlive(Number(holder.split(' ')[0])))
    ) {
      await removeIfHeld(lockPath, holder)
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

async function removeIfHeld(lockPath: string, content: string): Promise<void> {
  const current = await readFile(lockPath, 'utf8').catch(() => undefined)
  if (current === content) await rm(lockPath, { force: true })
}

export async function lockHolder(lockPath: string): Promise<number | undefined> {
  const content = await readFile(lockPath, 'utf8').catch(() => undefined)
  if (content === undefined) return undefined
  const holder = Number(content.split(' ')[0])
  return Number.isInteger(holder) && holder > 0 && isAlive(holder) ? holder : undefined
}
