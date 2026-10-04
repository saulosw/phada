import { afterEach, describe, expect, it, vi } from 'vitest'

describe('main module import', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not run the CLI when imported', async () => {
    vi.resetModules()
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await import('./main.js')

    expect(stdout).not.toHaveBeenCalled()
    expect(stderr).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })
})
