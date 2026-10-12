import { describe, expect, it } from 'vitest'
import { callLines, heritageLines, symbolLines, symbolNamed } from '../../test/support/file-map.js'
import { createExtractor } from './extract.js'
import type { FileMap } from './types.js'

const extractor = createExtractor()

async function mapOf(language: 'typescript' | 'tsx' | 'javascript', text: string) {
  const map = await extractor.extract(language, text)
  if (map === 'timeout') throw new Error('timeout')
  return map
}

const SERVICE = `import def, { a as b, c } from './x'
import * as ns from 'ns'
import 'side'
export interface Repo extends Base { find(id: string): User }
export type Id = string
export enum Color { Red }
export abstract class Service extends Base implements Repo, Other {
  private cache = new Map()
  constructor(private readonly repo: Repo) { super() }
  find(id: string): User { return this.repo.load(id) }
}
export const handler = async (req: Req, { res }: Ctx) => { await save(req); return ns.run() }
const LIMIT = 10
function helper(x = 1, ...rest: number[]) { return new Thing(x) }
export { helper as publicHelper }
export * from './all'
export default Service
`

describe('extract TypeScript', () => {
  let map: FileMap

  it('finds the declarations with their owner and whether they are exported', async () => {
    map = await mapOf('typescript', SERVICE)

    expect(symbolLines(map)).toEqual([
      'interface Repo exported',
      'method find < Repo exported',
      'parameter id < find',
      'type Id exported',
      'enum Color exported',
      'class Service exported',
      'variable cache < Service exported',
      'method constructor < Service exported',
      'parameter repo < constructor',
      'method find < Service exported',
      'parameter id < find',
      'function handler exported',
      'parameter req < handler',
      'parameter res < handler',
      'variable LIMIT',
      'function helper exported',
      'parameter x < helper',
      'parameter rest < helper',
    ])
  })

  it('records the lines and the signature up to the body', async () => {
    map = await mapOf('typescript', SERVICE)

    expect(symbolNamed(map, 'class', 'Service')).toMatchObject({ startLine: 7, endLine: 11 })
    expect(symbolNamed(map, 'method', 'find', 1)).toMatchObject({
      startLine: 10,
      endLine: 10,
      signature: 'find(id: string): User',
    })
    expect(symbolNamed(map, 'method', 'find', 0)?.signature).toBe('find(id: string): User')
    expect(symbolNamed(map, 'function', 'helper')?.signature).toBe(
      'function helper(x = 1, ...rest: number[])',
    )
    expect(symbolNamed(map, 'function', 'handler')?.signature).toBe(
      'handler = async (req: Req, { res }: Ctx) =>',
    )
  })

  it('records imports and re-exports', async () => {
    map = await mapOf('typescript', SERVICE)

    expect(map.imports).toEqual([
      { module: './x', name: 'def', kind: 'default', line: 1 },
      { module: './x', name: 'a', alias: 'b', kind: 'named', line: 1 },
      { module: './x', name: 'c', kind: 'named', line: 1 },
      { module: 'ns', name: 'ns', kind: 'namespace', line: 2 },
      { module: 'side', kind: 'side-effect', line: 3 },
      { module: './all', name: '*', kind: 'namespace', line: 16 },
    ])
  })

  it('records exports', async () => {
    map = await mapOf('typescript', SERVICE)

    expect(map.exports).toEqual([
      { name: 'Repo', line: 4 },
      { name: 'Id', line: 5 },
      { name: 'Color', line: 6 },
      { name: 'Service', line: 7 },
      { name: 'handler', line: 12 },
      { name: 'publicHelper', local: 'helper', line: 15 },
      { name: '*', module: './all', line: 16 },
      { name: 'default', local: 'Service', line: 17 },
    ])
  })

  it('records calls with what they are called on and who calls them', async () => {
    map = await mapOf('typescript', SERVICE)

    expect(callLines(map)).toEqual([
      'Map new in Service',
      'super in constructor',
      'load on this.repo in find',
      'save in handler',
      'run on ns in handler',
      'Thing new in helper',
    ])
  })

  it('records what classes and interfaces extend and implement', async () => {
    map = await mapOf('typescript', SERVICE)

    expect(heritageLines(map)).toEqual([
      'Repo extends Base',
      'Service extends Base',
      'Service implements Repo',
      'Service implements Other',
    ])
    expect(map.parseErrors).toBe(0)
  })

  it('re-exports named symbols from another module as imports too', async () => {
    map = await mapOf('typescript', "export { a, b as c } from './lib'\n")

    expect(map.imports).toEqual([
      { module: './lib', name: 'a', kind: 'named', line: 1 },
      { module: './lib', name: 'b', alias: 'c', kind: 'named', line: 1 },
    ])
    expect(map.exports).toEqual([
      { name: 'a', local: 'a', module: './lib', line: 1 },
      { name: 'c', local: 'b', module: './lib', line: 1 },
    ])
  })

  it('names a default export declaration', async () => {
    map = await mapOf('typescript', 'export default function main(argv: string[]) {}\n')

    expect(symbolLines(map)).toEqual(['function main exported', 'parameter argv < main'])
    expect(map.exports).toEqual([{ name: 'default', local: 'main', line: 1 }])
  })

  it('keeps local variables out and gives their calls to the function', async () => {
    map = await mapOf(
      'typescript',
      'export function run() {\n  const total = sum(1)\n  const done = () => notify(total)\n}\n',
    )

    expect(symbolLines(map)).toEqual(['function run exported'])
    expect(callLines(map)).toEqual(['sum in run', 'notify in run'])
  })
})

describe('extract TSX and JavaScript', () => {
  it('reads JSX in TSX', async () => {
    const map = await mapOf(
      'tsx',
      "export function App() { return <Button onClick={() => track('x')} /> }\n",
    )

    expect(symbolLines(map)).toEqual(['function App exported'])
    expect(callLines(map)).toEqual(['track in App'])
  })

  it('reads require as imports and JSX in JavaScript', async () => {
    const map = await mapOf(
      'javascript',
      "const { a, b: c } = require('lib')\nconst fs = require('fs')\nrequire('setup')\nmodule.exports = { f }\nfunction f(x) { return <div>{g(x)}</div> }\n",
    )

    expect(map.imports).toEqual([
      { module: 'lib', name: 'a', kind: 'require', line: 1 },
      { module: 'lib', name: 'b', alias: 'c', kind: 'require', line: 1 },
      { module: 'fs', name: 'fs', kind: 'require', line: 2 },
      { module: 'setup', kind: 'require', line: 3 },
    ])
    expect(symbolLines(map)).toEqual(['function f', 'parameter x < f'])
    expect(callLines(map)).toEqual(['g in f'])
  })

  it('accepts single-parameter arrows and default parameters in JavaScript', async () => {
    const map = await mapOf(
      'javascript',
      'export const twice = n => n * 2\nfunction f(a = 1, { b, c: [d] }) {}\n',
    )

    expect(symbolLines(map)).toEqual([
      'function twice exported',
      'parameter n < twice',
      'function f',
      'parameter a < f',
      'parameter b < f',
      'parameter d < f',
    ])
  })
})

describe('extract hostile files', () => {
  it('returns an empty map for an empty file', async () => {
    expect(await mapOf('typescript', '')).toEqual({
      symbols: [],
      imports: [],
      exports: [],
      calls: [],
      heritage: [],
      parseErrors: 0,
    })
  })

  it('reads a file that starts with a byte order mark', async () => {
    const map = await mapOf('typescript', '﻿export function f() {}\n')

    expect(symbolLines(map)).toEqual(['function f exported'])
  })

  it('counts parse errors and keeps what it could read', async () => {
    const map = await mapOf('typescript', 'export function ok() {}\nfunction (\n')

    expect(map.parseErrors).toBeGreaterThan(0)
    expect(symbolLines(map)).toContain('function ok exported')
  })

  it('reads one long minified line', async () => {
    const line = Array.from({ length: 20_000 }, (_, i) => `function f${i}(){g${i}()}`).join(';')

    const map = await mapOf('javascript', line)

    expect(map.symbols.filter((symbol) => symbol.kind === 'function')).toHaveLength(20_000)
  })

  it('gives up on a parse that takes longer than the timeout', async () => {
    let clock = 0
    const slow = createExtractor({ timeoutMs: 0, now: () => (clock += 1) })
    const text = Array.from({ length: 5_000 }, (_, i) => `function f${i}() { return ${i} }`).join(
      '\n',
    )

    expect(await slow.extract('typescript', text)).toBe('timeout')
  })
})
