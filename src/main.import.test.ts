import { afterEach, describe, expect, it, vi } from 'vitest'

describe('main module import', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not run main() when imported', async () => {
    vi.resetModules()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await import('./main.js')

    expect(log).not.toHaveBeenCalled()
  })
})
