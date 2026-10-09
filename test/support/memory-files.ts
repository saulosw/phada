import { dirname } from 'node:path'
import type { LocalFileSystem } from '../../src/config/local-files.js'

export interface MemoryFiles extends LocalFileSystem {
  files: Map<string, string>
  dirs: Set<string>
}

export function memoryFiles(
  initial: Record<string, string> = {},
  dirs: string[] = [],
): MemoryFiles {
  const files = new Map(Object.entries(initial))
  const knownDirs = new Set(dirs)
  return {
    files,
    dirs: knownDirs,
    readText: async (path) => files.get(path) ?? null,
    exists: async (path) => files.has(path) || knownDirs.has(path),
    writeNew: async (path, text) => {
      if (files.has(path)) return false
      if (!knownDirs.has(dirname(path))) throw new Error(`ENOENT: no folder ${dirname(path)}`)
      files.set(path, text)
      return true
    },
    makeDir: async (path) => {
      for (let dir = path; dir !== dirname(dir); dir = dirname(dir)) knownDirs.add(dir)
    },
    listDocs: async (path) => {
      if (files.has(path)) return [{ path, size: new TextEncoder().encode(files.get(path)).length }]
      const inside = [...files.keys()].filter(
        (file) => file.startsWith(`${path}/`) && file.endsWith('.md'),
      )
      if (inside.length === 0 && !knownDirs.has(path)) return null
      return inside
        .sort()
        .map((file) => ({ path: file, size: new TextEncoder().encode(files.get(file)).length }))
    },
  }
}
