import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface LocalDoc {
  path: string
  size: number
}

export interface LocalFileSystem {
  readText(path: string): Promise<string | null>
  exists(path: string): Promise<boolean>
  writeNew(path: string, text: string): Promise<boolean>
  makeDir(path: string): Promise<void>
  listDocs(path: string): Promise<LocalDoc[] | null>
}

export const nodeFileSystem: LocalFileSystem = {
  async readText(path) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  },
  async exists(path) {
    try {
      await stat(path)
      return true
    } catch (error) {
      if (isMissing(error)) return false
      throw error
    }
  },
  async writeNew(path, text) {
    try {
      await writeFile(path, text, { flag: 'wx' })
      return true
    } catch (error) {
      if (hasCode(error, 'EEXIST')) return false
      throw error
    }
  },
  async makeDir(path) {
    await mkdir(path, { recursive: true })
  },
  async listDocs(path) {
    let info
    try {
      info = await stat(path)
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
    if (info.isFile()) return [{ path, size: info.size }]
    const entries = await readdir(path, { recursive: true, withFileTypes: true })
    const docs = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
        .map(async (entry) => {
          const file = join(entry.parentPath, entry.name)
          return { path: file, size: (await stat(file)).size }
        }),
    )
    return docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  },
}

function isMissing(error: unknown): boolean {
  return hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
