import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main, PLACEHOLDER_MESSAGE } from './main.js'

const run = promisify(execFile)

describe('main', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints the placeholder message and returns exit code 0', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(main()).toBe(0)
    expect(log).toHaveBeenCalledWith(PLACEHOLDER_MESSAGE)
  })
})

describe('main as a script', () => {
  it('prints the placeholder message once and exits with code 0', async () => {
    // execFile rejects on a non-zero exit code, so resolving means exit 0.
    const { stdout } = await run(process.execPath, ['--import', 'tsx', 'src/main.ts'])

    expect(stdout.trim()).toBe(PLACEHOLDER_MESSAGE)
  }, 20_000)
})
