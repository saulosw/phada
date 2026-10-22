import { rmSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'phada-native-'
const OWNER_FILE = 'owner.pid'
const UNCLAIMED_GRACE_MS = 60_000

const openDirs = new Set<string>()

export async function openWorkDir(root: string = tmpdir()): Promise<string> {
  const dir = await mkdtemp(join(root, PREFIX))
  openDirs.add(dir)
  await writeFile(join(dir, OWNER_FILE), String(process.pid))
  return dir
}

export async function closeWorkDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
  openDirs.delete(dir)
}

export function removeOpenWorkDirs(): void {
  for (const dir of openDirs) rmSync(dir, { recursive: true, force: true })
  openDirs.clear()
}

export async function sweepOrphanWorkDirs(
  root: string = tmpdir(),
  isAlive: (pid: number) => boolean = processIsAlive,
): Promise<string[]> {
  const entries = await readdir(root).catch(() => [])
  const removed: string[] = []
  for (const name of entries) {
    if (!name.startsWith(PREFIX)) continue
    const dir = join(root, name)
    if (openDirs.has(dir)) continue
    const owner = await readFile(join(dir, OWNER_FILE), 'utf8').catch(() => undefined)
    const pid = owner === undefined ? undefined : Number(owner)
    const orphan =
      pid === undefined || !Number.isInteger(pid)
        ? await olderThan(dir, UNCLAIMED_GRACE_MS)
        : !isAlive(pid)
    if (!orphan || !(await ownedByMe(dir))) continue
    try {
      await rm(dir, { recursive: true, force: true })
      removed.push(dir)
    } catch {
      continue
    }
  }
  return removed
}

async function ownedByMe(dir: string): Promise<boolean> {
  const info = await stat(dir).catch(() => undefined)
  const uid = process.getuid?.()
  return info !== undefined && (uid === undefined || info.uid === uid)
}

async function olderThan(dir: string, ms: number): Promise<boolean> {
  const info = await stat(dir).catch(() => undefined)
  return info !== undefined && Date.now() - info.mtimeMs > ms
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}
