import { chmod, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeFileSystem } from './local-files.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phada-files-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('nodeFileSystem', () => {
  it('reads a file or null when it is missing', async () => {
    await writeFile(join(dir, 'a.md'), 'hello')

    expect(await nodeFileSystem.readText(join(dir, 'a.md'))).toBe('hello')
    expect(await nodeFileSystem.readText(join(dir, 'missing.md'))).toBeNull()
    expect(await nodeFileSystem.readText(join(dir, 'a.md', 'below'))).toBeNull()
  })

  it('tells whether a path exists', async () => {
    await mkdir(join(dir, '.git'))

    expect(await nodeFileSystem.exists(join(dir, '.git'))).toBe(true)
    expect(await nodeFileSystem.exists(join(dir, 'nope'))).toBe(false)
  })

  it('writes a new file only once', async () => {
    const path = join(dir, 'config.yml')

    expect(await nodeFileSystem.writeNew(path, 'first')).toBe(true)
    expect(await nodeFileSystem.writeNew(path, 'second')).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('first')
  })

  it('creates nested folders', async () => {
    await nodeFileSystem.makeDir(join(dir, 'a', 'b'))

    expect(await nodeFileSystem.exists(join(dir, 'a', 'b'))).toBe(true)
  })

  it('lists one file, the markdown files of a folder, or null', async () => {
    await mkdir(join(dir, 'notes', 'sub'), { recursive: true })
    await writeFile(join(dir, 'notes', 'b.md'), 'bb')
    await writeFile(join(dir, 'notes', 'sub', 'a.MD'), 'a')
    await writeFile(join(dir, 'notes', 'c.txt'), 'c')

    expect(await nodeFileSystem.listDocs(join(dir, 'notes', 'b.md'))).toEqual([
      { path: join(dir, 'notes', 'b.md'), size: 2 },
    ])
    expect(await nodeFileSystem.listDocs(join(dir, 'notes'))).toEqual([
      { path: join(dir, 'notes', 'b.md'), size: 2 },
      { path: join(dir, 'notes', 'sub', 'a.MD'), size: 1 },
    ])
    expect(await nodeFileSystem.listDocs(join(dir, 'missing'))).toBeNull()
  })
})

describe('nodeFileSystem.writeAtomic', () => {
  it('writes a file in a folder it creates', async () => {
    const path = join(dir, 'phada', 'config.yml')

    await nodeFileSystem.writeAtomic(path, 'provider: claude\n')

    expect(await readFile(path, 'utf8')).toBe('provider: claude\n')
    expect(await readdir(join(dir, 'phada'))).toEqual(['config.yml'])
  })

  it('replaces a file whole with its mode, leaving no temporary file behind', async () => {
    const path = join(dir, 'config.yml')
    await writeFile(path, 'provider: claude\n', { mode: 0o600 })

    await nodeFileSystem.writeAtomic(path, 'provider: codex\n')

    expect(await readFile(path, 'utf8')).toBe('provider: codex\n')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(dir)).toEqual(['config.yml'])
  })

  it('rejects a folder it may not write, keeping the file as it was', async () => {
    const path = join(dir, 'config.yml')
    await writeFile(path, 'provider: claude\n')
    await chmod(dir, 0o500)

    try {
      await expect(nodeFileSystem.writeAtomic(path, 'provider: codex\n')).rejects.toMatchObject({
        code: 'EACCES',
      })
    } finally {
      await chmod(dir, 0o700)
    }
    expect(await readFile(path, 'utf8')).toBe('provider: claude\n')
    expect(await readdir(dir)).toEqual(['config.yml'])
  })
})

describe('nodeFileSystem.listDir', () => {
  it('lists the names inside a folder and null for a missing one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phada-list-'))
    await writeFile(join(dir, 'b.md'), 'b')
    await mkdir(join(dir, 'a'))

    expect(await nodeFileSystem.listDir(dir)).toEqual(['a', 'b.md'])
    expect(await nodeFileSystem.listDir(join(dir, 'missing'))).toBeNull()
    expect(await nodeFileSystem.listDir(join(dir, 'b.md'))).toBeNull()
  })
})
