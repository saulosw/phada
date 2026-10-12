import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export function phadaCacheDir(env: NodeJS.ProcessEnv, home: string): string {
  const explicit = env.PHADA_CACHE_HOME?.trim()
  if (explicit) return explicit
  const xdg = env.XDG_CACHE_HOME?.trim()
  return xdg ? join(xdg, 'phada') : join(home, '.cache', 'phada')
}

export function mirrorDir(cacheDir: string, owner: string, repo: string): string {
  return join(cacheDir, 'repos', owner.toLowerCase(), `${repo.toLowerCase()}.git`)
}

export function indexFile(cacheDir: string, owner: string, repo: string): string {
  return join(cacheDir, 'index', owner.toLowerCase(), `${repo.toLowerCase()}.sqlite`)
}

export function repositoryCache(
  env: NodeJS.ProcessEnv,
  home: string,
  owner: string,
  repo: string,
): { mirror: string; index: string } {
  const cache = phadaCacheDir(env, home)
  return { mirror: mirrorDir(cache, owner, repo), index: indexFile(cache, owner, repo) }
}

export async function pathSize(path: string): Promise<number> {
  const stats = await lstat(path).catch(() => undefined)
  if (stats === undefined) return 0
  if (!stats.isDirectory()) return stats.size
  const entries = await readdir(path, { recursive: true, withFileTypes: true })
  const sizes = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => lstat(join(entry.parentPath, entry.name)).then((file) => file.size)),
  )
  return sizes.reduce((total, size) => total + size, 0)
}
