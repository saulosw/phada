import { join } from 'node:path'
import type { LocalFileSystem } from '../config/local-files.js'

export function readDirResolver(
  files: LocalFileSystem,
  home: string,
): (path: string) => Promise<string | undefined> {
  return async (path) => {
    const full = path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path
    return (await files.listDir(full)) === null ? undefined : full
  }
}
