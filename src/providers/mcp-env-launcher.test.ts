import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const LAUNCHER = fileURLToPath(new URL('./mcp-env-launcher.ts', import.meta.url))
const TSX = ['--import', import.meta.resolve('tsx')]

let temp: string

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'phada-launcher-'))
})

afterEach(() => {
  rmSync(temp, { recursive: true, force: true })
})

function launch(envFile: string, ...command: string[]) {
  return spawnSync(process.execPath, [...TSX, LAUNCHER, envFile, ...command], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', KEPT: 'kept' },
  })
}

describe('mcp-env-launcher', () => {
  it('runs the command with the env of the file on top of its own', () => {
    const envFile = join(temp, 'env.json')
    writeFileSync(envFile, JSON.stringify({ env: { K: 'v' } }))

    const result = launch(
      envFile,
      process.execPath,
      '-e',
      'process.stdout.write(`${process.env.K}/${process.env.KEPT}`)',
    )

    expect(result.stdout).toBe('v/kept')
    expect(result.status).toBe(0)
  })

  it('exits with the code of the command', () => {
    const envFile = join(temp, 'env.json')
    writeFileSync(envFile, JSON.stringify({ env: {} }))

    expect(launch(envFile, process.execPath, '-e', 'process.exit(7)').status).toBe(7)
  })

  it('exits with 2 and says nothing of the file when it cannot be read', () => {
    const result = launch(join(temp, 'missing.json'), process.execPath, '-e', '')

    expect(result.status).toBe(2)
    expect(result.stderr).toBe('phada: the MCP server environment could not be read.\n')
  })
})
