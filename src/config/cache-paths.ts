import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const OBSERVED_FILE = '.sqlite'

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
): { mirror: string; index: string; observed: string } {
  const cache = phadaCacheDir(env, home)
  return {
    mirror: mirrorDir(cache, owner, repo),
    index: indexFile(cache, owner, repo),
    observed: join(cache, 'observed', owner.toLowerCase(), `${repo.toLowerCase()}.sqlite`),
  }
}

export async function observedRepositories(cacheDir: string): Promise<string[]> {
  const root = join(cacheDir, 'observed')
  const owners = await readdir(root, { withFileTypes: true }).catch(() => [])
  const repos = await Promise.all(
    owners
      .filter((owner) => owner.isDirectory())
      .map(async (owner) =>
        (await readdir(join(root, owner.name), { withFileTypes: true }).catch(() => []))
          .filter((file) => file.isFile() && file.name.endsWith(OBSERVED_FILE))
          .map((file) => `${owner.name}/${file.name.slice(0, -OBSERVED_FILE.length)}`),
      ),
  )
  return repos.flat().sort()
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
