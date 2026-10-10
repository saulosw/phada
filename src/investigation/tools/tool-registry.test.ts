import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BUDGET_EXHAUSTED } from './budget.js'
import { CheckoutError } from '../checkout/checkout.js'
import { InvalidRepoPathError } from '../checkout/repo-path.js'
import { ToolLog } from './tool-log.js'
import { createToolbox, ToolFailure } from './tool-registry.js'
import type { RegisteredTool } from './tool-registry.js'

function echoTool(runs: string[] = []): RegisteredTool<{ path: string }> {
  return {
    definition: { name: 'echo', description: 'Echo a path.', inputSchema: {} },
    args: z.strictObject({ path: z.string() }),
    run: async ({ path }) => {
      runs.push(path)
      if (path === 'fail') throw new ToolFailure('no-such-thing', 'there is no such thing')
      if (path === 'checkout') throw new CheckoutError('symlink', 'x is a symbolic link')
      if (path === 'escape')
        throw new InvalidRepoPathError('"../x" is not a path inside the repository')
      if (path === 'crash') throw new Error('internal detail /home/secret')
      return { text: `got ${path}`, paths: [path], touched: [path] }
    },
  }
}

function bigTool(size: number): RegisteredTool<{ path: string }> {
  return {
    definition: { name: 'big', description: 'Big answer.', inputSchema: {} },
    args: z.strictObject({ path: z.string() }),
    run: async ({ path }) => ({ text: 'é'.repeat(size / 2), paths: [path], touched: [path] }),
  }
}

describe('createToolbox answer size', () => {
  it('cuts an answer over 32 KB and says how to read less', async () => {
    const log = new ToolLog()
    const toolbox = createToolbox([bigTool(100_000)], log, 'review')

    const result = await toolbox.call('big', { path: 'dist/app.min.js' })

    expect(result.isError).toBe(false)
    expect(result.text).toMatch(
      /\n\[answer cut at 32000 of 100000 bytes: read a smaller range with from and to, or narrow the search\]$/,
    )
    expect(
      Buffer.byteLength(result.text.slice(0, result.text.lastIndexOf('\n['))),
    ).toBeLessThanOrEqual(32_000)
    expect(result.text).not.toContain('\uFFFD')
    expect(log.records[0]?.bytes).toBe(Buffer.byteLength(result.text))
  })

  it('cuts an answer to what is left of the byte budget', async () => {
    const toolbox = createToolbox([bigTool(1000)], new ToolLog(), 'review', {
      calls: 10,
      bytes: 600,
    })

    await toolbox.call('big', { path: 'a' })
    const second = await toolbox.call('big', { path: 'b' })

    expect(second.text).toBe(BUDGET_EXHAUSTED)
  })

  it('never returns more than the budget allows in one call', async () => {
    const toolbox = createToolbox([bigTool(1000)], new ToolLog(), 'review', {
      calls: 10,
      bytes: 400,
    })

    const first = await toolbox.call('big', { path: 'a' })

    expect(
      Buffer.byteLength(first.text.slice(0, first.text.lastIndexOf('\n['))),
    ).toBeLessThanOrEqual(400)
  })
})

describe('createToolbox', () => {
  it('exposes the definitions and runs a tool', async () => {
    const log = new ToolLog()
    const toolbox = createToolbox([echoTool()], log, 'review')

    expect(toolbox.definitions.map((definition) => definition.name)).toEqual(['echo'])
    expect(await toolbox.call('echo', { path: 'src/a.ts' })).toEqual({
      text: 'got src/a.ts',
      isError: false,
    })
    expect(log.records).toEqual([
      expect.objectContaining({
        pass: 'review',
        tool: 'echo',
        args: { path: 'src/a.ts' },
        paths: ['src/a.ts'],
        bytes: 12,
      }),
    ])
    expect(log.records[0]?.error).toBeUndefined()
  })

  it('refuses an unknown tool', async () => {
    const log = new ToolLog()
    const toolbox = createToolbox([echoTool()], log, 'review')

    expect(await toolbox.call('rm', {})).toEqual({
      text: 'Unknown tool "rm". Available: echo.',
      isError: true,
    })
    expect(log.records[0]).toMatchObject({ tool: 'rm', error: 'unknown-tool', bytes: 0 })
  })

  it('refuses invalid arguments without running the tool', async () => {
    const runs: string[] = []
    const toolbox = createToolbox([echoTool(runs)], new ToolLog(), 'review')

    const result = await toolbox.call('echo', { path: 3 })

    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/^Invalid arguments for echo: /)
    expect(runs).toEqual([])
  })

  it.each([
    ['fail', 'there is no such thing', 'no-such-thing'],
    ['checkout', 'x is a symbolic link', 'symlink'],
    ['escape', '"../x" is not a path inside the repository', 'invalid-path'],
    ['crash', 'echo failed', 'failed'],
  ])('turns a %s error into a tool error', async (path, text, error) => {
    const log = new ToolLog()
    const toolbox = createToolbox([echoTool()], log, 'review')

    expect(await toolbox.call('echo', { path })).toEqual({ text, isError: true })
    expect(log.records[0]).toMatchObject({ error, paths: [] })
  })

  it('stops at the call budget without running the tool', async () => {
    const runs: string[] = []
    const log = new ToolLog()
    const toolbox = createToolbox([echoTool(runs)], log, 'review', { calls: 2, bytes: 1000 })

    await toolbox.call('echo', { path: 'a' })
    await toolbox.call('nope', {})
    const third = await toolbox.call('echo', { path: 'b' })

    expect(third).toEqual({ text: BUDGET_EXHAUSTED, isError: true })
    expect(runs).toEqual(['a'])
    expect(log.records.at(-1)).toMatchObject({ tool: 'echo', error: 'budget' })
  })

  it('stops at the byte budget', async () => {
    const runs: string[] = []
    const toolbox = createToolbox([echoTool(runs)], new ToolLog(), 'review', {
      calls: 10,
      bytes: 10,
    })

    await toolbox.call('echo', { path: 'long-path' })
    const second = await toolbox.call('echo', { path: 'x' })

    expect(second.text).toBe(BUDGET_EXHAUSTED)
    expect(runs).toEqual(['long-path'])
  })

  it('keeps one budget per pass and one log', async () => {
    const log = new ToolLog()
    const review = createToolbox([echoTool()], log, 'review', { calls: 1, bytes: 1000 })
    const verify = createToolbox([echoTool()], log, 'verify', { calls: 1, bytes: 1000 })

    await review.call('echo', { path: 'a' })
    const verified = await verify.call('echo', { path: 'b' })

    expect(verified.isError).toBe(false)
    expect(log.records.map((record) => record.pass)).toEqual(['review', 'verify'])
    expect(review.touchedPaths()).toEqual(['a'])
    expect(verify.touchedPaths()).toEqual(['b'])
  })

  it('lists touched paths once, in order', async () => {
    const toolbox = createToolbox([echoTool()], new ToolLog(), 'review')

    await toolbox.call('echo', { path: 'b' })
    await toolbox.call('echo', { path: 'a' })
    await toolbox.call('echo', { path: 'b' })

    expect(toolbox.touchedPaths()).toEqual(['b', 'a'])
  })
})
