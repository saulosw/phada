import { describe, expect, it } from 'vitest'
import { indexFixture } from '../../../test/support/index-fixture.js'
import { openRepositoryGraph } from '../../graph/repository-graph.js'
import type { RepositoryGraph } from '../../graph/types.js'
import { graphTools } from './graph-tools.js'
import { ToolLog } from './tool-log.js'
import { createToolbox } from './tool-registry.js'

const FILES = {
  'src/users.ts': `export function getUser(id: string) {
  return id
}
`,
  'src/api.ts': `import { getUser } from './users'
export function handleGet(id: string) {
  return getUser(id)
}
export function handlePut(id: string) {
  return getUser(id)
}
export const handlers = [getUser]
`,
  'src/lib.ts': 'export function validate(x: unknown) {}\nexport function save(x: unknown) {}\n',
  'src/orders.ts': `import { validate, save } from './lib'
import express from 'express'
export function handleOrder(input: unknown) {
  validate(input)
  save(input)
  express()
}
export function handlePayment(input: unknown) {
  validate(input)
  save(input)
}
`,
  'src/other.ts': 'function getUser() {\n  return 1\n}\n',
}

async function setup(now?: () => number) {
  const { reader, readText } = await indexFixture(FILES)
  const graph = await openRepositoryGraph({ reader, readText })
  const log = new ToolLog()
  const toolbox = createToolbox(graphTools(graph, now === undefined ? {} : { now }), log, 'review')
  return { graph, log, toolbox }
}

describe('graph tools', () => {
  it('registers find_symbol, callers, dependencies and similar', async () => {
    const { toolbox } = await setup()

    expect(toolbox.definitions.map((definition) => definition.name)).toEqual([
      'find_symbol',
      'callers',
      'dependencies',
      'similar',
    ])
  })

  it('finds definitions with their place and signature', async () => {
    const { toolbox, log } = await setup()

    const result = await toolbox.call('find_symbol', { name: 'getUser' })

    expect(result.text).toBe(
      [
        'function getUser — src/users.ts:1-3 [exported] · function getUser(id: string)',
        'function getUser — src/other.ts:1-3 · function getUser()',
      ].join('\n'),
    )
    expect(log.records[0]?.paths).toEqual(['src/users.ts', 'src/other.ts'])
    expect(toolbox.touchedPaths()).toEqual([])
    expect((await toolbox.call('find_symbol', { name: 'nothing' })).text).toBe(
      'No symbol named nothing in the indexed files.',
    )
  })

  it('lists callers grouped by file with the code of each line', async () => {
    const { toolbox } = await setup()

    const result = await toolbox.call('callers', { name: 'getUser', path: 'src/users.ts' })

    expect(result.text).toBe(
      [
        'Callers and uses of function getUser (src/users.ts:1-3):',
        'src/api.ts',
        '  3 in handleGet: return getUser(id)',
        '  6 in handlePut: return getUser(id)',
        '  8 (uses): export const handlers = [getUser]',
      ].join('\n'),
    )
    expect(toolbox.touchedPaths()).toEqual(['src/api.ts'])
  })

  it('says when there are more definitions than it shows and when nothing calls the symbol', async () => {
    const { toolbox } = await setup()

    const result = await toolbox.call('callers', { name: 'getUser' })

    expect(result.text).toContain(
      'Callers and uses of function getUser (src/other.ts:1-3):\nNo callers or uses found in the indexed files.',
    )
    expect((await toolbox.call('callers', { name: 'missing' })).text).toBe(
      'No symbol named missing in the indexed files.',
    )
  })

  it('lists what a symbol depends on, including packages', async () => {
    const { toolbox } = await setup()

    const result = await toolbox.call('dependencies', { name: 'handleOrder' })

    expect(result.text).toBe(
      [
        'What function handleOrder (src/orders.ts:3-7) depends on:',
        '  validate (calls, line 4) → src/lib.ts:1 function validate',
        '  save (calls, line 5) → src/lib.ts:2 function save',
        '  express (calls, line 6) → external (express)',
      ].join('\n'),
    )
  })

  it('lists functions built like the target', async () => {
    const { toolbox } = await setup()

    const result = await toolbox.call('similar', { name: 'handleOrder' })

    expect(result.text).toMatch(
      /^Functions built like function handleOrder \(src\/orders\.ts:3-7\):\n {2}function handlePayment — src\/orders\.ts:8-11 · score 0\.\d+ · shares: save, validate$/,
    )
    expect((await toolbox.call('similar', { name: 'handlers' })).text).toContain(
      'similar compares functions and methods only',
    )
  })

  it('fails a query that takes too long', async () => {
    let clock = 0
    const { toolbox } = await setup(() => {
      clock += 6_000
      return clock
    })

    const result = await toolbox.call('callers', { name: 'getUser' })

    expect(result).toEqual({ isError: true, text: 'The query took too long: narrow it with path' })
  })
})

describe('graph tools with many results', () => {
  it('stops at 60 sites and says how many more there are', async () => {
    const calls = Array.from({ length: 70 }, () => '  f()').join('\n')
    const { reader, readText } = await indexFixture({
      'a.ts': 'export function f() {}\n',
      'b.ts': `import { f } from './a'\nexport function g() {\n${calls}\n}\n`,
    })
    const graph: RepositoryGraph = await openRepositoryGraph({ reader, readText })
    const toolbox = createToolbox(graphTools(graph), new ToolLog(), 'review')

    const result = await toolbox.call('callers', { name: 'f' })

    expect(result.text.split('\n').filter((line) => line.startsWith('  '))).toHaveLength(60)
    expect(result.text.endsWith('+10 more callers')).toBe(true)
  })
})
