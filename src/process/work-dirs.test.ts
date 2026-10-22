import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeWorkDir, openWorkDir, removeOpenWorkDirs, sweepOrphanWorkDirs } from './work-dirs.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'phada-work-dirs-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('work dirs', () => {
  it('opens a folder that names its owner process', async () => {
    const dir = await openWorkDir(root)

    expect(dir.startsWith(join(root, 'phada-native-'))).toBe(true)
    expect(readFileSync(join(dir, 'owner.pid'), 'utf8')).toBe(String(process.pid))
    await closeWorkDir(dir)
    expect(existsSync(dir)).toBe(false)
  })

  it('removes the open folders at once', async () => {
    const one = await openWorkDir(root)
    const two = await openWorkDir(root)

    removeOpenWorkDirs()

    expect(existsSync(one)).toBe(false)
    expect(existsSync(two)).toBe(false)
  })

  it('sweeps only the folders of processes that are gone', async () => {
    const dead = join(root, 'phada-native-dead')
    const alive = join(root, 'phada-native-alive')
    const young = join(root, 'phada-native-young')
    const old = join(root, 'phada-native-old')
    const other = join(root, 'something-else')
    for (const dir of [dead, alive, young, old, other]) mkdirSync(dir)
    writeFileSync(join(dead, 'owner.pid'), '111')
    writeFileSync(join(alive, 'owner.pid'), '222')
    const past = new Date(Date.now() - 120_000)
    utimesSync(old, past, past)

    const removed = await sweepOrphanWorkDirs(root, (pid) => pid === 222)

    expect(removed.sort()).toEqual([dead, old].sort())
    expect(existsSync(alive)).toBe(true)
    expect(existsSync(young)).toBe(true)
    expect(existsSync(other)).toBe(true)
  })
})
